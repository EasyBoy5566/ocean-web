import {
  BufferAttribute, Color, Float32BufferAttribute, Mesh, PerspectiveCamera, Raycaster, Scene, Vector2, Vector3, Vector4,
  type DataTexture, type Object3D, type ShaderMaterial, type Texture, type WebGLRenderer,
} from 'three';
import { params } from '../app/params';
import type { TierSettings } from '../app/quality';
import type { Environment, EnvironmentConfig } from '../env/environment';
import { globals } from '../gfx/globals';
import { createCameraGrid } from '../gfx/grid';
import { createTerrainMaterial, type TerrainColors } from '../gfx/materials';
import { PlanarReflection } from '../gfx/reflection';
import { RippleSim, type SimDomain } from '../gfx/ripples';
import { Splash } from '../gfx/splash';
import { createWater, type WaterMode, type Wave } from '../gfx/water';
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
  waves?: Wave[];
  steepness?: number;
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
  readonly camera = new PerspectiveCamera(50, 1, 0.1, 30000);
  protected deps: WorldDeps;
  protected cfg!: WorldConfig;
  protected waterMaterial!: ShaderMaterial;
  protected water!: Mesh;
  protected terrain!: Mesh;
  protected reflection!: PlanarReflection;
  protected sim: RippleSim | null = null;
  protected dataTex!: DataTexture;
  protected splash!: Splash;
  protected stones!: Stones;
  protected time = 0;
  private basePitch = 0;
  private aspect = 1;
  private disposables: { dispose(): void }[] = [];

  constructor(deps: WorldDeps) {
    this.deps = deps;
  }

  protected abstract configure(): WorldConfig;
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
    const tmat = createTerrainMaterial(cfg.terrain.colors);
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

    const w = cfg.water;
    const { mesh, material } = createWater({
      mode: w.mode,
      normalTex: this.deps.waterNormalTex,
      reflection: this.reflection.target.texture,
      reflectionMatrix: this.reflection.textureMatrix,
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
      waves: w.waves,
      steepness: w.steepness,
      grid: { cols: tier.water.cols, rows: tier.water.rows, near: 0.4, far: w.far, halfWidth: cfg.terrain.halfWidth },
    });
    this.water = mesh;
    this.waterMaterial = material;
    this.scene.add(mesh);
    this.disposables.push(mesh.geometry, material);

    this.splash = new Splash();
    this.splash.onLand = (x, z, s) => {
      if (s > 0.018 && this.sim && Math.random() < 0.35) this.sim.addDrop(x, z, 0.03, 0.0012);
    };
    this.scene.add(this.splash.points);
    this.disposables.push(this.splash);

    this.stones = new Stones(this.scene, {
      waterHeight: (x, z) => this.waterHeight(x, z),
      terrainHeight: (x, z) => this.solidHeight(x, z),
      onSkip: (p, v, n) => {
        const e = clamp(Math.hypot(v.x, v.z) / 18, 0, 1);
        this.splash.burst('skip', p, e, v);
        this.sim?.addDrop(p.x, p.z, 0.07, 0.006 + 0.004 * e);
        this.deps.sound.splash('skip', p, e * (1 - n * 0.03));
      },
      onPlunge: (p, v) => {
        const e = clamp(v.length() / 16, 0, 1);
        this.splash.burst('plunge', p, e);
        this.sim?.addDrop(p.x, p.z, 0.1, 0.016 + 0.012 * e);
        this.deps.sound.splash('plunge', p, e);
      },
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
    this.splash.pixelScale = drawH / (2 * Math.tan((this.camera.fov * DEG) / 2));
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
    this.splash.update(dt, (x, z) => this.waterHeight(x, z));
    this.onUpdate?.(dt);
    if (this.sim) {
      this.sim.update(this.deps.renderer, dt);
      this.waterMaterial.uniforms.uSimTex.value = this.sim.texture;
    }
  }

  render(renderer: WebGLRenderer) {
    if (params.dbg.has('nosplash')) this.splash.points.visible = false;
    if (params.dbg.has('norefl')) this.waterMaterial.uniforms.uReflStrength.value = 0;
    if (params.dbg.has('noterrain')) this.terrain.visible = false;
    if (params.dbg.has('double')) this.waterMaterial.side = 2;
    if (params.dbg.has('nospec')) this.waterMaterial.uniforms.uRough.value = 0.6;
    if (params.dbg.has('nofoam')) { this.waterMaterial.uniforms.uSteep.value = 1e-6; this.waterMaterial.uniforms.uShoreFoam.value = 0; }
    if (params.dbg.has('nosim')) this.waterMaterial.uniforms.uSimMap.value = new Vector4(1, 1, 1, 0);
    if (params.dbg.has('nodata')) this.waterMaterial.uniforms.uDataBounds.value = new Vector4(1e6, 1e6, 1, 1);
    if (params.dbg.has('noprops')) this.scene.children.forEach((c) => { if ((c as { isInstancedMesh?: boolean }).isInstancedMesh) c.visible = false; });
    this.reflection.render(renderer, this.scene, this.camera, 0, [this.water]);
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.camera);
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
    this.splash.burst('tap', p, 0.5);
    this.sim?.addDrop(p.x, p.z, 0.06 * scale, 0.011 + 0.003 * scale);
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
