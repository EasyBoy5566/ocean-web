import { Color, Vector4 } from 'three';
import { createLitMaterial } from '../gfx/materials';
import {
  createBoxGeometry, createConiferGeometry, createInstances, createRockGeometry, type Placement,
} from '../gfx/props';
import { clamp, lerp, mulberry32, smoothstep } from '../util/math';
import { Noise2D } from '../util/noise';
import { rgb, World, type WorldConfig } from './world';

/** Smooth minimum (polynomial), keeps shorelines rounded where edges meet. */
function smin(a: number, b: number, k: number) {
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return lerp(b, a, h) - k * h * (1 - h);
}

const DOCK_Y = 0.55;

/**
 * A long mountain lake seen from the end of a wooden dock, looking east so
 * the sun comes up through a notch in the far ridge.
 */
export class LakeWorld extends World {
  readonly id = 'lake' as const;
  private noise = new Noise2D(1234);
  private nextFish = 2;
  private rnd = mulberry32(77);

  protected configure(): WorldConfig {
    return {
      env: { heading: 90, fogDensity: 0.5e-4, mist: 0.6, mistHeight: 16, cloudCover: 0.4, windDir: [1, 0.25] },
      camera: { eyeY: DOCK_Y + 1.7, vfovPortrait: 72, vfovLandscape: 46, horizonPortrait: 0.3, horizonLandscape: 0.12 },
      water: {
        mode: 'lake',
        absorb: [0.5, 0.13, 0.1],
        scatter: [0.0022, 0.0075, 0.0078],
        detail: 0.075,
        detailScale: [0.085, 0.22],
        detailSpeed: 0.018,
        roughness: 0.04,
        roughnessFar: 0.1,
        reflectionDistort: 0.06,
        reflectionStrength: 1,
        shoreFoam: 0.4,
        sss: [0, 0, 0],
        far: 9000,
      },
      terrain: {
        near: 0.3,
        far: 9000,
        halfWidth: 1.75,
        colors: {
          grass: rgb(0.07, 0.1, 0.035),
          forest: rgb(0.022, 0.045, 0.024),
          rock: rgb(0.15, 0.14, 0.13),
          sand: rgb(0.2, 0.18, 0.15),
          bed: rgb(0.085, 0.08, 0.055),
        },
      },
      sim: { near: 1.2, far: 140, halfWidth: 1.0 },
      data: { bounds: new Vector4(-420, -1720, 840, 1740), width: 256, height: 512, depthMax: 12, flowMax: 1 },
    };
  }

  private centre(z: number) {
    return 22 * Math.sin(z * 0.0021) + 40 * smoothstep(-300, -1500, z) * Math.sin(z * 0.004);
  }

  /** Signed distance (m) to the shore: positive inside the lake. */
  private shore(x: number, z: number) {
    const n = this.noise;
    const hw = 24 + 0.21 * Math.max(-z, 0) + 9 * n.fbm(z * 0.006, 3.7, 3);
    const lateral = hw - Math.abs(x - this.centre(z)) + 4 * n.fbm(x * 0.02, z * 0.02, 2);
    const front = 6 - z;
    const back = z + 1650;
    return smin(lateral, smin(front, back, 30), 25);
  }

  terrainHeight(x: number, z: number): number {
    const n = this.noise;
    const s = this.shore(x, z);
    if (s > 0) {
      const depth = 30 * (1 - Math.exp(-s / 90)) + 0.95 * Math.sqrt(s);
      return 0.4 - depth + 0.25 * n.noise(x * 0.15, z * 0.15) * Math.min(s / 4, 1);
    }
    const d = -s;
    const dist = Math.hypot(x, z);
    const oct = dist < 900 ? 5 : dist < 2500 ? 4 : 3;
    const ridge = 0.3 * n.ridged(x * 0.0008 + 3.3, z * 0.0008, oct) + 0.7 * (0.5 + 0.5 * n.fbm(x * 0.0006 - 1.7, z * 0.0006, oct));
    let amp = lerp(18, 520, smoothstep(15, 1100, d));
    // a gap in the far ridge where the sun rises
    const gap = Math.exp(-Math.pow((x - this.centre(-2200)) / 420, 2)) * smoothstep(-1500, -2600, z);
    amp *= 1 - 0.55 * gap;
    const far = smoothstep(3500, 7000, -z) * 700 * (0.5 + 0.5 * n.fbm(x * 0.0004, z * 0.0004 + 7.1, 3));
    const rolling = n.fbm(x * 0.007, z * 0.007, dist < 400 ? 4 : 2) * 10 * smoothstep(0, 60, d) * (1 - smoothstep(300, 1200, dist));
    return 0.4 + d * 0.16 + ridge * amp * smoothstep(0, 120, d) + rolling + far;
  }

  protected paint(x: number, y: number, z: number, ny: number): [number, number, number, number] {
    const s = this.shore(x, z);
    const shoreBand = 1 - smoothstep(0.3, 2.2, y);
    const forest = smoothstep(2, 14, -s) * (1 - smoothstep(1250, 1650, y)) * smoothstep(0.55, 0.8, ny);
    const alpine = smoothstep(1300, 1700, y);
    return [forest, alpine * 0.8, shoreBand * smoothstep(-6, 1, s), 0];
  }

  protected populate() {
    const veg = this.deps.tier.vegetation;
    const rnd = mulberry32(4242);

    // Forest: sample in camera space so density follows what is on screen.
    const trees: Placement[] = [];
    const target = Math.round(2600 * veg);
    for (let tries = 0; tries < target * 12 && trees.length < target; tries++) {
      const dist = 25 * Math.pow(1400 / 25, rnd());
      const x = (rnd() * 2 - 1) * 1.2 * dist;
      const z = -dist;
      const s = this.shore(x, z);
      if (s > -3) continue;
      const y = this.terrainHeight(x, z);
      if (y > 1500) continue;
      const slope = Math.abs(this.terrainHeight(x + 2, z) - y) + Math.abs(this.terrainHeight(x, z + 2) - y);
      if (slope > 2.6) continue;
      const density = this.noise.fbm(x * 0.004 + 9, z * 0.004, 3);
      if (density < -0.25 + rnd() * 0.5) continue;
      const h = 9 + rnd() * 13;
      const tint = 0.75 + rnd() * 0.5;
      trees.push({
        x, y: y - 0.5, z, scale: [h * (0.85 + rnd() * 0.3), h, h * (0.85 + rnd() * 0.3)], rotY: rnd() * 6.28,
        color: new Color(tint, tint * (0.9 + rnd() * 0.2), tint),
      });
    }
    const treeGeo = this.track(createConiferGeometry());
    const treeMat = this.track(createLitMaterial({ kind: 'foliage', sway: 0.6 }));
    this.add(createInstances(treeGeo, treeMat, trees));

    // Boulders along the near shoreline and a few in the shallows.
    const rocks: Placement[] = [];
    for (let tries = 0; tries < 4000 && rocks.length < 70; tries++) {
      const z = -4 - Math.pow(rnd(), 1.6) * 260;
      const x = (rnd() * 2 - 1) * (40 + 0.3 * -z);
      const s = this.shore(x, z);
      if (s < -6 || s > 2.5) continue;
      const r = 0.4 + Math.pow(rnd(), 2) * 1.8;
      const g = 0.75 + rnd() * 0.35;
      rocks.push({
        x, y: this.terrainHeight(x, z) + r * 0.15, z, scale: [r, r * (0.6 + rnd() * 0.5), r], rotY: rnd() * 6.28,
        color: new Color(0.2 * g, 0.19 * g, 0.18 * g),
      });
    }
    const rockMat = this.track(createLitMaterial({ kind: 'rock', moss: new Color(0.035, 0.06, 0.02), mossAmount: 0.7 }));
    [3, 8].forEach((seed, i) => {
      const geo = this.track(createRockGeometry(seed));
      this.add(createInstances(geo, rockMat, rocks.filter((_, k) => k % 2 === i)));
    });

    this.buildDock();
  }

  private buildDock() {
    const wood = new Color(0.11, 0.085, 0.062);
    const mat = this.track(createLitMaterial({ kind: 'wood' }));
    const plankGeo = this.track(createBoxGeometry(2.3, 0.06, 0.2, wood));
    const planks: Placement[] = [];
    const rnd = mulberry32(9);
    for (let z = 9; z > -2.1; z -= 0.225) {
      const g = 0.82 + rnd() * 0.3;
      planks.push({
        x: (rnd() - 0.5) * 0.05, y: DOCK_Y + (rnd() - 0.5) * 0.012, z, scale: 1, rotY: (rnd() - 0.5) * 0.02,
        color: new Color(g, g * 0.97, g * 0.94),
      });
    }
    this.add(createInstances(plankGeo, mat, planks));
    const beamGeo = this.track(createBoxGeometry(0.12, 0.16, 11.2, wood.clone().multiplyScalar(0.8)));
    this.add(createInstances(beamGeo, mat, [
      { x: -0.9, y: DOCK_Y - 0.11, z: 3.4, scale: 1 },
      { x: 0.9, y: DOCK_Y - 0.11, z: 3.4, scale: 1 },
    ]));
    const postGeo = this.track(createBoxGeometry(0.16, 1, 0.16, wood.clone().multiplyScalar(0.7)));
    const posts: Placement[] = [];
    for (let z = 8; z >= -2.2; z -= 2.5) {
      for (const x of [-1.05, 1.05]) {
        const bed = this.terrainHeight(x, z);
        const top = DOCK_Y + 0.25;
        posts.push({ x, y: (top + bed) / 2, z: Math.max(z, -1.95), scale: [1, top - bed, 1], rotY: (rnd() - 0.5) * 0.2 });
      }
    }
    this.add(createInstances(postGeo, mat, posts));
  }

  solidHeight(x: number, z: number) {
    // The dock deck counts as ground for stones.
    if (Math.abs(x) < 1.15 && z < 9 && z > -2.1) return DOCK_Y;
    return this.terrainHeight(x, z);
  }

  protected onUpdate(dt: number) {
    // Fish and insects dimpling the surface now and then, more at dusk.
    this.nextFish -= dt * (1 + this.deps.env.night * 0.5);
    if (this.nextFish <= 0 && this.sim) {
      const dist = 8 + this.rnd() * 70;
      const x = (this.rnd() * 2 - 1) * dist * 0.6;
      const z = -dist;
      if (this.shore(x, z) > 2) this.sim.addDrop(x, z, 0.035 + this.rnd() * 0.05, 0.0025 + this.rnd() * 0.004);
      this.nextFish = 1.2 + this.rnd() * 4;
    }
  }
}
