import { Color, Vector3, Vector4, type Object3D } from 'three';
import { loadGroundLayer, loadImpostor, loadModel, type GroundLayer, type ImpostorAtlas } from '../gfx/assets';
import { createLayerMaterial, meshParts } from '../gfx/scanned';
import { createLitMaterial } from '../gfx/materials';
import { createBroadleafGeometry, createInstances, createRockGeometry, type Placement } from '../gfx/props';
import type { SeaState } from '../gfx/ocean';
import { clamp, lerp, mulberry32, smoothstep } from '../util/math';
import { Noise2D } from '../util/noise';
import { rgb, World, type ScannedPart, type WorldConfig } from './world';

const SEA: SeaState = {
  windSpeed: 10.5,
  windDir: [0.3, 1],
  fetch: 90000,
  swellHeight: 1.1,
  swellPeriod: 10.5,
  swellDir: [0.08, 1],
  choppiness: 1.3,
};

function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
  const vx = bx - ax, vz = bz - az;
  const t = clamp(((px - ax) * vx + (pz - az) * vz) / (vx * vx + vz * vz), 0, 1);
  return Math.hypot(px - (ax + vx * t), pz - (az + vz * t));
}

interface Stack {
  x: number;
  z: number;
  r: number;
  h: number;
}

/** A rocky coast facing west over the open sea, so the sun sets into the water. */
export class OceanWorld extends World {
  readonly id = 'ocean' as const;
  private noise = new Noise2D(808);
  private stacks: Stack[] = [
    { x: -58, z: -265, r: 9, h: 27 },
    { x: -36, z: -196, r: 5, h: 13 },
    { x: 78, z: -500, r: 11, h: 21 },
    { x: -20, z: -700, r: 6, h: 9 },
    { x: 24, z: -125, r: 3, h: 4 },
  ];
  private surfPoints: Vector3[] = [];
  private surfTimer = 0;
  private prevHeights: number[] = [];
  private rnd = mulberry32(31);
  private kit: { cliff: GroundLayer; rocks: ScannedPart[]; shrubs: ImpostorAtlas[] } | null = null;

  async loadAssets() {
    const [coast, cliff, pebbles, rocksA, rocksB, island, small] = await Promise.all([
      loadGroundLayer('coast_sand_rocks_02', 3.5),
      loadGroundLayer('rock_face_03', 7),
      loadGroundLayer('ganges_river_pebbles', 2.5),
      loadModel('models/coast_rocks_03.glb'),
      loadModel('models/coast_land_rocks_04.glb'),
      loadImpostor('island'),
      loadImpostor('small'),
    ]);
    this.layers = { ground: coast, rock: cliff, shore: coast, bed: pebbles };
    const parts = (root: Object3D) => meshParts(root).map((p) => ({ ...p, geometry: this.track(p.geometry) }));
    this.kit = { cliff, rocks: [...parts(rocksA.scene), ...parts(rocksB.scene)], shrubs: [island, small] };
  }

  protected configure(): WorldConfig {
    return {
      env: { heading: 270, fogDensity: 0.6e-4, mist: 0.15, mistHeight: 30, cloudCover: 0.46, windDir: [0.25, 1] },
      camera: { eyeY: 5.25, vfovPortrait: 70, vfovLandscape: 45, horizonPortrait: 0.38, horizonLandscape: 0.2 },
      water: {
        mode: 'ocean',
        absorb: [0.7, 0.3, 0.2],
        scatter: [0.0022, 0.0085, 0.0135],
        detail: 0.03,
        detailScale: [0.055, 0.16],
        detailSpeed: 0.05,
        roughness: 0.05,
        roughnessFar: 0.12,
        reflectionDistort: 0.12,
        reflectionStrength: 1,
        shoreFoam: 1,
        sss: [0.03, 0.3, 0.26],
        sea: SEA,
        far: 14000,
      },
      terrain: {
        near: 0.4,
        far: 14000,
        halfWidth: 1.75,
        colors: {
          grass: rgb(0.075, 0.09, 0.035),
          forest: rgb(0.03, 0.05, 0.022),
          rock: rgb(0.1, 0.095, 0.09),
          sand: rgb(0.32, 0.28, 0.22),
          bed: rgb(0.08, 0.08, 0.06),
        },
      },
      sim: { near: 4.5, far: 230, halfWidth: 1.0 },
      data: { bounds: new Vector4(-460, -1000, 820, 1012), width: 512, height: 512, depthMax: 20, flowMax: 1 },
    };
  }

  /** Signed distance offshore (m): positive at sea, negative on land. */
  private offshore(x: number, z: number) {
    const n = this.noise;
    const shoreZ = -2.6 + (x > 0 ? 0.004 * x * x : 0.0015 * x * x) + 2.2 * n.fbm(x * 0.03, 1.3, 3) * smoothstep(1, 6, Math.abs(x));
    let off = shoreZ - z;
    // headland on the left, angled away so it frames the view without hiding the sunset
    const head = distToSegment(x, z, -110, 15, -600, -900) - (42 - 14 * smoothstep(-100, -900, z)) - 12 * n.fbm(x * 0.012, z * 0.012, 3);
    off = Math.min(off, head);
    // a far island off to the right
    const isl = Math.hypot((x - 2600) / 2.4, z + 7200) - 520;
    return Math.min(off, isl);
  }

  terrainHeight(x: number, z: number): number {
    const n = this.noise;
    const off = this.offshore(x, z);
    const dist = Math.hypot(x, z);
    let h: number;
    if (off > 0) {
      // rocky coast: deep right off the rocks, a few reefs further out
      const reef = n.ridged(x * 0.04, z * 0.04, dist < 300 ? 3 : 1) * 2.2 * smoothstep(12, 40, off) * (1 - smoothstep(70, 160, off));
      h = -(2.6 + off * 0.24 + Math.pow(off, 1.25) * 0.005) + reef;
      h = Math.max(h, -70);
    } else {
      const d = -off;
      const top = 3.5 + 8 * smoothstep(12, 45, d) + 0.05 * d;
      const bumps = n.fbm(x * 0.06, z * 0.06, dist < 300 ? 3 : 1) * 1.1 * smoothstep(1, 5, d) * (1 - smoothstep(200, 900, dist));
      const ridge = (0.5 + 0.5 * n.fbm(x * 0.004 + 2, z * 0.004, dist < 1500 ? 4 : 2)) * 85 * smoothstep(20, 260, d);
      // steep but continuous drop into the sea (no vertical steps for the grid to alias)
      h = Math.min(-1.3 + d * 2.3, top) + bumps + ridge;
    }
    for (const s of this.stacks) {
      const r = Math.hypot(x - s.x, z - s.z) / s.r;
      // only an underwater plinth: the visible stack is a mesh
      if (r < 1.6) h = Math.max(h, Math.min(-1.2, -14 + 14 * smoothstep(1.6, 0.8, r)));
    }
    return h;
  }

  waterHeight(x: number, z: number): number {
    const h = this.ocean ? this.ocean.heightAt(x, z, this.time) : 0;
    // same damping over shallows as the shader
    return h * smoothstep(0.6, 9, -this.terrainHeight(x, z));
  }

  protected paint(x: number, y: number, z: number, ny: number): [number, number, number, number] {
    const off = this.offshore(x, z);
    const grassy = smoothstep(9, 16, y) * smoothstep(0.75, 0.9, ny) * (off < -15 ? 1 : 0);
    const shrub = grassy * smoothstep(30, 60, -off) * 0.7;
    const wetRock = 1 - smoothstep(0, 6, y);
    const beach = 0;
    return [shrub, (1 - grassy) * 0.6 + wetRock * 0.3, beach, grassy * 0.6];
  }

  protected populate() {
    const rnd = mulberry32(99);
    const rockMat = this.track(createLitMaterial({ kind: 'rock', moss: new Color(0.06, 0.07, 0.03), mossAmount: 0.25 }));

    // Sea stacks: tall weathered rocks, faced with photographed cliff rock.
    const stackGeo = this.track(createRockGeometry(41, 3, 1));
    const stackMat = this.kit ? this.track(createLayerMaterial(this.kit.cliff, { triplanar: true })) : rockMat;
    if (this.kit) stackGeo.attributes.color.array.fill(1);
    this.add(createInstances(stackGeo, stackMat, this.stacks.map((s, i) => ({
      x: s.x, y: s.h * 0.4 - 2.5, z: s.z, scale: [s.r * 0.95, s.h * 0.66, s.r * 0.9], rotY: i * 1.7,
      color: new Color(0.1, 0.095, 0.088),
    }))));

    // Boulders on the shore and in the surf.
    const rocks: Placement[] = [];
    for (let tries = 0; tries < 6000 && rocks.length < 90; tries++) {
      const z = -3 - Math.pow(rnd(), 1.7) * 200;
      const x = (rnd() * 2 - 1) * (25 + 0.8 * -z);
      const off = this.offshore(x, z);
      if (off < -4 || off > 22) continue;
      const r = 0.6 + Math.pow(rnd(), 2.2) * 2.6;
      const g = 0.7 + rnd() * 0.4;
      rocks.push({
        x, y: this.terrainHeight(x, z) - r * 0.25, z, scale: [r, r * (0.55 + rnd() * 0.4), r * (0.8 + rnd() * 0.4)],
        rotY: rnd() * 6.28, tilt: [(rnd() - 0.5) * 0.4, (rnd() - 0.5) * 0.4],
        color: new Color(0.11 * g, 0.105 * g, 0.1 * g),
      });
      if (off > 0 && off < 14 && r > 1.1) this.surfPoints.push(new Vector3(x, 0, z));
    }
    if (this.kit) {
      // scanned coastal rock formations, scaled down to boulder size
      this.placeParts(this.kit.rocks, rocks.map((r, i) => {
        const sc = r.scale as number[];
        return { x: r.x, y: this.terrainHeight(r.x, r.z), z: r.z, size: sc[0] * 2.4, stretchY: 1.8, embed: 0.3, rotY: r.rotY, part: i };
      }));
    } else {
      [5, 17, 29].forEach((seed, i) => {
        const geo = this.track(createRockGeometry(seed));
        this.add(createInstances(geo, rockMat, rocks.filter((_, k) => k % 3 === i)));
      });
    }
    // Wind-bent shrubs and small trees on the headland.
    const veg = this.deps.tier.vegetation;
    const shrubs: Placement[] = [];
    for (let tries = 0; tries < 9000 && shrubs.length < 260 * veg; tries++) {
      const z = -20 - rnd() * 950;
      const x = -120 - rnd() * 400;
      const off = this.offshore(x, z);
      if (off > -30) continue;
      const y = this.terrainHeight(x, z);
      if (y < 12) continue;
      const s = 2.5 + rnd() * 5;
      shrubs.push({ x, y: y - 0.3, z, scale: [s * 1.3, s, s * 1.3], rotY: rnd() * 6.28, tilt: [0.15, 0.1], color: new Color(0.85, 0.9 + rnd() * 0.2, 0.8) });
    }
    if (this.kit) {
      this.plantTrees(this.kit.shrubs, shrubs.map((p, i) => ({
        x: p.x, y: p.y, z: p.z, height: (p.scale as number[])[1] * 0.9, frame: i, flip: i % 2 === 0, kind: i % 2,
        tint: p.color ?? new Color(1, 1, 1),
      })), 1.2);
    } else {
      const shrubGeo = this.track(createBroadleafGeometry(12));
      const shrubMat = this.track(createLitMaterial({ kind: 'foliage', sway: 0.5 }));
      this.add(createInstances(shrubGeo, shrubMat, shrubs));
    }
    this.prevHeights = this.surfPoints.map(() => 0);
  }

  protected onUpdate(dt: number) {
    // Swell breaking on rocks throws up spray.
    this.surfTimer -= dt;
    if (this.surfTimer > 0) return;
    this.surfTimer = 0.12;
    this.surfPoints.forEach((p, i) => {
      const h = this.waterHeight(p.x, p.z);
      const rising = h - this.prevHeights[i];
      this.prevHeights[i] = h;
      if (h > 0.35 && rising > 0.035 && this.rnd() < 0.5) {
        const e = clamp(rising * 8, 0.3, 1);
        const at = new Vector3(p.x + (this.rnd() - 0.5) * 2, h, p.z + 1.5);
        this.splash.emit(at, {
          count: Math.round(lerp(12, 40, e)), speed: [0.3, 1.6], up: [1.5 * e, 4.5 * e], radius: 1.2,
          size: [0.006, 0.03], life: [0.8, 1.6],
        });
        if (this.sim?.covers(at.x, at.z)) this.sim.addDrop(at.x, at.z, 0.6, 0.004);
        if (this.rnd() < 0.3) this.deps.sound.splash('plunge', at, e * 0.6);
      }
    });
  }
}
