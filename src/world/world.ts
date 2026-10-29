import {
  BufferAttribute, Color, Float32BufferAttribute, Mesh, PerspectiveCamera, Raycaster, Scene, Vector2, Vector3, Vector4,
  type BufferGeometry, type DataTexture, type MeshStandardMaterial, type Object3D, type ShaderMaterial, type Texture,
  type WebGLRenderer,
} from 'three';
import { params } from '../app/params';
import type { TierSettings } from '../app/quality';
import type { Environment, EnvironmentConfig } from '../env/environment';
import { globals } from '../gfx/globals';
import { createCameraGrid } from '../gfx/grid';
import { createTerrainMaterial, type TerrainColors, type TerrainLayers } from '../gfx/materials';
import { PlanarReflection } from '../gfx/reflection';
import { RippleSim, type SimDomain } from '../gfx/ripples';
import { LAYER_SCENE, LAYER_SURFACE, SceneTarget } from '../gfx/composite';
import { SplashFX } from '../gfx/splash';
import type { ImpostorAtlas } from '../gfx/assets';
import { FFTOcean, type SeaState } from '../gfx/ocean';
import {
  createImpostors, createScannedMaterial, scatter, type ScannedOptions, type TreeItem,
} from '../gfx/scanned';
import { createWater, type WaterMode } from '../gfx/water';
import { bakeWaterData } from '../gfx/waterData';
import { clamp, DEG, lerp, smoothstep } from '../util/math';
import { Stones } from './stones';

export type SceneId = 'lake' | 'ocean' | 'river';

/** What the world tells the audio layer. Positions are in world metres. */
export interface SoundSink {
  splash(kind: 'tap' | 'plunge' | 'skip' | 'land', pos: Vector3, energy: number): void;
  throwWhoosh(power: number): void;
}

export interface WorldDeps {
  renderer: WebGLRenderer;
  env: Environment;
  tier: TierSettings;
  noiseTex: Texture;
  waterNormalTex: Texture;
  halfFloat: boolean;
  sound: SoundSink;
}

export interface CameraFraming {
  eyeY: number;
  vfovPortrait: number;
  vfovLandscape: number;
  /** Horizon height above screen centre in NDC (−1..1). */
  horizonPortrait: number;
  horizonLandscape: number;
  yawDeg?: number;
}

export interface WaterLook {
  mode: WaterMode;
  absorb: [number, number, number];
  scatter: [number, number, number];
  detail: number;
  detailScale: [number, number];
  detailSpeed: number;
  roughness: number;
  roughnessFar: number;
  reflectionDistort: number;
  reflectionStrength: number;
  shoreFoam: number;
  sss: [number, number, number];
  /** Sea state for the spectral ocean (ocean mode). */
  sea?: SeaState;
  far: number;
}

export interface WorldConfig {
  env: EnvironmentConfig;
  camera: CameraFraming;
  water: WaterLook;
  terrain: { near: number; far: number; halfWidth: number; colors: TerrainColors };
  sim: SimDomain;
  data: { bounds: Vector4; width: number; height: number; depthMax: number; flowMax: number };
}

const raycaster = new Raycaster();
const tmpV = new Vector3();

/**
 * Shared machinery for the three scenes: terrain and water built around a
 * fixed camera, reflections, interactive ripples, splashes and stones.
 * Subclasses provide the landscape (height function, painting, props).
 */
export abstract class World {
  abstract readonly id: SceneId;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(50, 1, 0.25, 30000);
  protected deps: WorldDeps;
  protected cfg!: WorldConfig;
  protected waterMaterial!: ShaderMaterial;
  protected water!: Mesh;
  protected terrain!: Mesh;
  protected reflection!: PlanarReflection;
  protected sim: RippleSim | null = null;
  protected ocean: FFTOcean | null = null;
  /** Photoscanned ground layers, when the scene loaded them. */
  protected layers: TerrainLayers | undefined;
  protected dataTex!: DataTexture;
  protected splash!: SplashFX;
  protected sceneTarget!: SceneTarget;
  protected stones!: Stones;
  protected time = 0;
  private basePitch = 0;
  private aspect = 1;
  private disposables: { dispose(): void }[] = [];

  constructor(deps: WorldDeps) {
    this.deps = deps;
  }

  protected abstract configure(): WorldConfig;
  /** Fetch textures and models before build(); scenes override this. */
  async loadAssets(): Promise<void> {}
  /** Ground height (m) relative to the mean water level. Negative = under water. */
  abstract terrainHeight(x: number, z: number): number;
  /** Per-vertex terrain material weights: forest, rock, sand, dry. */
  protected abstract paint(x: number, y: number, z: number, ny: number): [number, number, number, number];
  protected abstract populate(): void;
  protected flow?(x: number, z: number): [number, number];
  protected foam?(x: number, z: number): number;
  protected onUpdate?(dt: number): void;

  /** Height of anything solid (terrain, docks) for picking and stone collisions. */
  solidHeight(x: number, z: number): number {
    return this.terrainHeight(x, z);
  }

  /** Surface height of the water at (x, z) right now. */
  waterHeight(_x: number, _z: number): number {
    return 0;
  }

  get envConfig() {
    return this.cfg.env;
  }

  build() {
    this.cfg = this.configure();
    const { tier, renderer } = this.deps;
    const cfg = this.cfg;
    this.scene.add(this.deps.env.dome.mesh);

    // Terrain
    const tgeo = createCameraGrid({
      cols: tier.terrain.cols,
      rows: tier.terrain.rows,
      near: cfg.terrain.near,
      far: cfg.terrain.far,
      halfWidth: cfg.terrain.halfWidth,
      height: (x, z) => this.terrainHeight(x, z),
    });
    tgeo.computeVertexNormals();
    const pos = tgeo.attributes.position as BufferAttribute;
    const nrm = tgeo.attributes.normal as BufferAttribute;
    const mask = new Float32Array(pos.count * 4);
    for (let i = 0; i < pos.count; i++) {
      const m = this.paint(pos.getX(i), pos.getY(i), pos.getZ(i), nrm.getY(i));
      mask.set(m, i * 4);
    }
    tgeo.setAttribute('aMask', new Float32BufferAttribute(mask, 4));
    const tmat = createTerrainMaterial(cfg.terrain.colors, this.layers);
    this.terrain = new Mesh(tgeo, tmat);
    this.terrain.frustumCulled = false;
    this.scene.add(this.terrain);
    this.disposables.push(tgeo, tmat);

    // Water facts (depth, flow, foam) and interactive ripples
    this.dataTex = bakeWaterData({
      ...cfg.data,
      terrainHeight: (x, z) => this.terrainHeight(x, z),
      flow: this.flow ? (x, z) => this.flow!(x, z) : undefined,
      foam: this.foam ? (x, z) => this.foam!(x, z) : undefined,
    });
    this.disposables.push(this.dataTex);
    if (this.deps.halfFloat) {
      this.sim = new RippleSim(cfg.sim, tier.simRows, {
        tex: this.flow ? this.dataTex : null,
        bounds: cfg.data.bounds,
        flowMax: cfg.data.flowMax,
      });
      this.sim.clear(renderer);
      this.disposables.push(this.sim);
    }

    this.reflection = new PlanarReflection(tier.reflectionScale, this.deps.halfFloat);
    this.disposables.push(this.reflection);
    this.sceneTarget = new SceneTarget(this.deps.halfFloat, tier.tier === 'low' ? 0 : 4);
    this.disposables.push(this.sceneTarget);

    const w = cfg.water;
    if (w.sea) {
      this.ocean = this.track(new FFTOcean(w.sea, tier.oceanN));
      this.ocean.update(renderer, 0, 1 / 60);
    }
    const oc = this.ocean;
    const { mesh, material } = createWater({
      mode: w.mode,
      normalTex: this.deps.waterNormalTex,
      reflection: this.reflection.target.texture,
      reflectionMatrix: this.reflection.textureMatrix,
      scene: { color: this.sceneTarget.color, depth: this.sceneTarget.depth },
      sim: {
        tex: this.sim ? this.sim.texture : null,
        map: this.sim ? this.sim.map : new Vector4(1, 1, 1, 0),
        size: this.sim ? new Vector2(this.sim.width, this.sim.height) : new Vector2(1, 1),
      },
      data: { tex: this.dataTex, bounds: cfg.data.bounds, depthMax: cfg.data.depthMax, flowMax: cfg.data.flowMax },
      detail: w.detail,
      detailScale: w.detailScale,
      detailSpeed: w.detailSpeed,
      windDir: cfg.env.windDir,
      roughness: w.roughness,
      roughnessFar: w.roughnessFar,
      reflectionDistort: w.reflectionDistort,
      reflectionStrength: w.reflectionStrength,
      shoreFoam: w.shoreFoam,
      sss: w.sss,
      fft: oc ? { disp: [0, 1, 2].map((c) => oc.disp(c)), deriv: [0, 1, 2].map((c) => oc.deriv(c)), lengths: oc.lengths, size: oc.N } : undefined,
      grid: { cols: tier.water.cols, rows: tier.water.rows, near: 0.4, far: w.far, halfWidth: cfg.terrain.halfWidth },
    });
    this.water = mesh;
    this.waterMaterial = material;
    this.scene.add(mesh);
    this.disposables.push(mesh.geometry, material);

    this.splash = new SplashFX();
    this.splash.onLand = (x, z, s) => {
      // larger drops falling back leave their own small rings
      if (s > 0.004 && this.sim && Math.random() < 0.5) this.sim.addDrop(x, z, 0.012 + s * 2, 0.0008 + s * 0.15);
    };
    this.splash.objects.forEach((o) => this.scene.add(o));
    this.disposables.push(this.splash);

    this.stones = new Stones(this.scene, {
      waterHeight: (x, z) => this.waterHeight(x, z),
      terrainHeight: (x, z) => this.solidHeight(x, z),
      onSkip: (p, v, n) => {
        const e = clamp(Math.hypot(v.x, v.z) / 18, 0, 1);
        this.splash.skip(p, e, v);
        this.sim?.addDrop(p.x, p.z, 0.06, 0.007 + 0.005 * e);
        this.deps.sound.splash('skip', p, e * (1 - n * 0.03));
      },
      onPlunge: (p, v) => {
        const e = clamp(v.length() / 16, 0, 1);
        this.sim?.addDrop(p.x, p.z, 0.09 + 0.04 * e, 0.02 + 0.016 * e);
        // the jet falling back starts a second set of rings
        this.splash.plunge(p, e, (q) => this.sim?.addDrop(q.x, q.z, 0.05, 0.008 + 0.006 * e));
        this.deps.sound.splash('plunge', p, e);
      },
      onSink: (p) => this.splash.bubbles.emit(p, 1, 0.03),
      onLand: (p, v) => this.deps.sound.splash('land', p, clamp(v.length() / 16, 0, 1)),
    });
    this.disposables.push(this.stones);

    this.populate();
    this.applyWaterUniforms();
  }

  /** Called when this world becomes active (also after a scene switch). */
  activate() {
    this.applyWaterUniforms();
    this.deps.env.configure(this.cfg.env);
  }

  private applyWaterUniforms() {
    globals.uWaterAbsorb.value.set(...this.cfg.water.absorb);
    globals.uWaterScatter.value.set(...this.cfg.water.scatter);
    globals.uWaterLevel.value = 0;
  }

  protected track<T extends { dispose(): void }>(d: T): T {
    this.disposables.push(d);
    return d;
  }

  protected add(o: Object3D) {
    this.scene.add(o);
  }

  private scannedCache = new Map<string, ShaderMaterial>();

  /** One shader material per source material and option set, shared by all its instances. */
  protected scannedMaterial(src: MeshStandardMaterial, o: ScannedOptions = {}): ShaderMaterial {
    const key = `${src.uuid}|${JSON.stringify(o)}`;
    let m = this.scannedCache.get(key);
    if (!m) {
      m = this.track(createScannedMaterial(src, o));
      this.scannedCache.set(key, m);
    }
    return m;
  }

  /**
   * Scatters scanned model parts: each placement gets a part (round robin) and
   * is scaled so the part's footprint matches `size` metres across.
   */
  protected placeParts(parts: ScannedPart[], items: PartItem[], o: ScannedOptions = {}) {
    if (!parts.length || !items.length) return;
    const groups = parts.map(() => [] as PartItem[]);
    items.forEach((it, i) => groups[(it.part ?? i) % parts.length].push(it));
    groups.forEach((group, i) => {
      if (!group.length) return;
      const part = parts[i];
      const foot = Math.max(part.size.x, part.size.z, 1e-3);
      const mat = this.scannedMaterial(part.material, o);
      const mesh = scatter(part.geometry, mat, group.map((it) => {
        const k = it.size / foot;
        const ky = k * (it.stretchY ?? 1);
        const y = it.y - part.size.y * ky * (it.embed ?? 0);
        return { x: it.x, y, z: it.z, scale: [k, ky, k], rotY: it.rotY, tilt: it.tilt, tint: it.tint };
      }));
      this.add(mesh);
    });
  }

  /** Billboard trees; `kind` picks the atlas. */
  protected plantTrees(atlases: ImpostorAtlas[], items: (TreeItem & { kind: number })[], sway = 1) {
    atlases.forEach((atlas, k) => {
      const mine = items.filter((t) => t.kind % atlases.length === k);
      if (!mine.length) return;
      const mesh = createImpostors(atlas, mine, sway);
      this.track(mesh.geometry);
      this.track(mesh.material as ShaderMaterial);
      this.add(mesh);
    });
  }

  resize(width: number, height: number, drawW: number, drawH: number) {
    this.aspect = width / height;
    const f = this.cfg.camera;
    const t = smoothstep(0.55, 1.8, this.aspect);
    this.camera.fov = lerp(f.vfovPortrait, f.vfovLandscape, t);
    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
    const horizon = lerp(f.horizonPortrait, f.horizonLandscape, t);
    this.basePitch = -Math.atan(horizon * Math.tan((this.camera.fov * DEG) / 2));
    this.reflection.setSize(drawW, drawH);
    this.sceneTarget.setSize(drawW, drawH);
    this.waterMaterial.uniforms.uResolution.value.set(drawW, drawH);
    this.splash.setViewport(drawW, drawH, drawH / (2 * Math.tan((this.camera.fov * DEG) / 2)));
    this.poseCamera();
  }

  private poseCamera() {
    const t = this.time;
    const f = this.cfg.camera;
    this.camera.position.set(Math.sin(t * 0.21) * 0.015, f.eyeY + Math.sin(t * 0.33) * 0.012, 0);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(
      this.basePitch + Math.sin(t * 0.27) * 0.0018 + Math.sin(t * 0.61) * 0.0006,
      (f.yawDeg ?? 0) * DEG + Math.sin(t * 0.17) * 0.0025,
      Math.sin(t * 0.23) * 0.0012,
    );
    this.camera.updateMatrixWorld();
  }

  update(dt: number) {
    this.time += dt;
    this.poseCamera();
    this.stones.update(dt);
    this.splash.update(dt, (x, z) => this.waterHeight(x, z), this.time);
    this.onUpdate?.(dt);
    if (this.ocean) {
      this.ocean.update(this.deps.renderer, this.time, dt);
      const u = this.waterMaterial.uniforms;
      for (let c = 0; c < 3; c++) {
        u[`uDisp${c}`].value = this.ocean.disp(c);
        u[`uDeriv${c}`].value = this.ocean.deriv(c);
      }
    }
    if (this.sim) {
      this.sim.update(this.deps.renderer, dt);
      this.waterMaterial.uniforms.uSimTex.value = this.sim.texture;
    }
  }

  render(renderer: WebGLRenderer) {
    if (params.dbg.has('norefl')) this.waterMaterial.uniforms.uReflStrength.value = 0;
    if (params.dbg.has('noterrain')) this.terrain.visible = false;
    if (params.dbg.has('double')) this.waterMaterial.side = 2;
    if (params.dbg.has('nospec')) this.waterMaterial.uniforms.uRough.value = 0.6;
    if (params.dbg.has('nofoam')) this.waterMaterial.uniforms.uShoreFoam.value = 0;
    if (params.dbg.has('nosim')) this.waterMaterial.uniforms.uSimMap.value = new Vector4(1, 1, 1, 0);
    if (params.dbg.has('nodata')) this.waterMaterial.uniforms.uDataBounds.value = new Vector4(1e6, 1e6, 1, 1);
    if (params.dbg.has('noprops')) this.scene.children.forEach((c) => { if ((c as { isInstancedMesh?: boolean }).isInstancedMesh) c.visible = false; });
    this.reflection.render(renderer, this.scene, this.camera, 0);
    // 1. everything behind and under the water, into a texture the water can refract
    this.camera.layers.set(LAYER_SCENE);
    renderer.setRenderTarget(this.sceneTarget.target);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    // 2. that image (and its depth) on screen, then the water surface and spray over it
    renderer.setRenderTarget(null);
    this.sceneTarget.composite(renderer);
    this.camera.layers.set(LAYER_SURFACE);
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.scene, this.camera);
    renderer.autoClear = autoClear;
    this.camera.layers.set(LAYER_SCENE);
  }

  /** Finds where a screen point meets the water, or null if land or sky is in the way. */
  pickWater(ndcX: number, ndcY: number): Vector3 | null {
    raycaster.setFromCamera(new Vector2(ndcX, ndcY), this.camera);
    const o = raycaster.ray.origin, d = raycaster.ray.direction;
    if (d.y > -0.002) return null;
    let t = (o.y - this.waterHeight(o.x + d.x * 10, o.z + d.z * 10)) / -d.y;
    for (let i = 0; i < 4; i++) {
      tmpV.copy(o).addScaledVector(d, t);
      t = (o.y - this.waterHeight(tmpV.x, tmpV.z)) / -d.y;
    }
    if (t > 6000) return null;
    // Is land in the way?
    const steps = 64;
    for (let i = 1; i <= steps; i++) {
      const s = t * Math.pow(i / steps, 1.5);
      tmpV.copy(o).addScaledVector(d, s);
      if (this.solidHeight(tmpV.x, tmpV.z) > tmpV.y + 0.02) return null;
    }
    return o.clone().addScaledVector(d, t);
  }

  tap(ndcX: number, ndcY: number): boolean {
    const p = this.pickWater(ndcX, ndcY);
    if (!p) return false;
    const dist = p.distanceTo(this.camera.position);
    const scale = clamp(dist / 12, 1, 6);
    this.sim?.addDrop(p.x, p.z, 0.045 * scale, 0.012 + 0.003 * scale);
    this.splash.tap(p, (q) => this.sim?.addDrop(q.x, q.z, 0.03 * scale, 0.004));
    this.deps.sound.splash('tap', p, 0.5);
    return true;
  }

  /**
   * Throws a stone from a swipe. `up` and `side` are swipe velocities in screen
   * heights per second; a quick flat flick skips, a slow lob plops.
   */
  throwStone(up: number, side: number, startNdcX: number) {
    const power = clamp((up - 0.45) / 2.4, 0, 1);
    const speed = lerp(6, 22, power);
    const elev = lerp(32, 5, Math.pow(power, 0.8)) * DEG;
    const halfH = Math.atan(Math.tan((this.camera.fov * DEG) / 2) * this.aspect);
    const yaw = clamp(Math.atan2(side, Math.max(up, 0.1)) * 0.7 + startNdcX * halfH * 0.6, -0.7, 0.7);
    const fwd = new Vector3(0, 0, -1).applyAxisAngle(new Vector3(0, 1, 0), -yaw + this.camera.rotation.y);
    const vel = fwd.clone().multiplyScalar(Math.cos(elev) * speed);
    vel.y = Math.sin(elev) * speed;
    const right = new Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion).setY(0).normalize();
    const origin = this.camera.position.clone().addScaledVector(right, 0.28).add(new Vector3(0, -0.4, 0)).addScaledVector(fwd, 0.4);
    this.stones.throw(origin, vel);
    this.deps.sound.throwWhoosh(power);
  }

  dispose() {
    this.scene.remove(this.deps.env.dome.mesh);
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.scene.clear();
  }
}

export const rgb = (r: number, g: number, b: number) => new Color(r, g, b);

export interface ScannedPart {
  geometry: BufferGeometry;
  material: MeshStandardMaterial;
  size: Vector3;
  name: string;
}

export interface PartItem {
  x: number;
  y: number;
  z: number;
  /** Footprint across, metres. */
  size: number;
  stretchY?: number;
  /** Fraction of the part's height pushed below `y` (hides the cut skirt of scanned rocks). */
  embed?: number;
  rotY?: number;
  tilt?: [number, number];
  tint?: Color;
  part?: number;
}
