import { Color, Vector4 } from 'three';
import { Fireflies } from '../gfx/fireflies';
import { createLitMaterial } from '../gfx/materials';
import {
  createBroadleafGeometry, createConiferGeometry, createInstances, createRockGeometry, type Placement,
} from '../gfx/props';
import { clamp, lerp, mulberry32, smoothstep } from '../util/math';
import { Noise2D } from '../util/noise';
import { rgb, World, type WorldConfig } from './world';

interface Boulder {
  x: number;
  z: number;
  r: number;
}

const FLOW_MAX = 1.6;

/**
 * A forested river valley facing south. The river runs towards the viewer,
 * past boulders that churn white water, and fireflies come out at night.
 */
export class RiverWorld extends World {
  readonly id = 'river' as const;
  private noise = new Noise2D(2024);
  private boulders: Boulder[] = [];
  private fireflies: Fireflies | null = null;
  private pixelScale = 800;

  constructor(...args: ConstructorParameters<typeof World>) {
    super(...args);
    // Boulders must exist before the terrain and water data are baked.
    const rnd = mulberry32(606);
    for (let tries = 0; tries < 2000 && this.boulders.length < 34; tries++) {
      const z = -6 - Math.pow(rnd(), 1.5) * 300;
      const c = this.centre(z);
      const hw = this.halfWidth(z);
      const x = c + (rnd() * 2 - 1) * hw * 0.8;
      const r = 0.45 + Math.pow(rnd(), 2) * 1.3;
      if (this.boulders.some((b) => Math.hypot(b.x - x, b.z - z) < b.r + r + 1.5)) continue;
      this.boulders.push({ x, z, r });
    }
  }

  protected configure(): WorldConfig {
    return {
      env: { heading: 180, fogDensity: 1.1e-4, mist: 0.45, mistHeight: 12, cloudCover: 0.36, windDir: [0.3, 1] },
      camera: { eyeY: 2.1, vfovPortrait: 72, vfovLandscape: 48, horizonPortrait: 0.26, horizonLandscape: 0.1, yawDeg: -10 },
      water: {
        mode: 'river',
        absorb: [0.7, 0.2, 0.28],
        scatter: [0.0018, 0.0065, 0.0048],
        detail: 0.07,
        detailScale: [0.32, 0.85],
        detailSpeed: 0.0,
        roughness: 0.06,
        roughnessFar: 0.14,
        reflectionDistort: 0.07,
        reflectionStrength: 1,
        shoreFoam: 0.6,
        sss: [0, 0, 0],
        far: 9000,
      },
      terrain: {
        near: 0.3,
        far: 9000,
        halfWidth: 1.75,
        colors: {
          grass: rgb(0.06, 0.09, 0.03),
          forest: rgb(0.02, 0.045, 0.02),
          rock: rgb(0.14, 0.135, 0.12),
          sand: rgb(0.11, 0.105, 0.09),
          bed: rgb(0.07, 0.07, 0.05),
        },
      },
      sim: { near: 1.0, far: 130, halfWidth: 1.0 },
      data: { bounds: new Vector4(-70, -440, 200, 465), width: 256, height: 512, depthMax: 3, flowMax: FLOW_MAX },
    };
  }

  private centre(z: number) {
    const s = smoothstep(0, -160, z);
    return lerp(8, 2 + 34 * Math.sin(z * 0.0052 + 1.2), s) + 6 * this.noise.fbm(z * 0.01, 4.2, 2);
  }

  private halfWidth(z: number) {
    return 7.2 + 2.2 * Math.sin(z * 0.017 + 0.4) + 1.5 * this.noise.noise(z * 0.03, 9.1);
  }

  terrainHeight(x: number, z: number): number {
    const n = this.noise;
    const dist = Math.hypot(x, z);
    const c = this.centre(z);
    const hw = this.halfWidth(z);
    const dx = Math.abs(x - c);
    let h: number;
    if (dx < hw) {
      const q = dx / hw;
      h = 0.25 - 1.25 * Math.pow(1 - q * q, 0.7) + 0.1 * n.noise(x * 0.6, z * 0.6);
    } else {
      const d = dx - hw;
      const oct = dist < 600 ? 5 : dist < 2000 ? 4 : 3;
      const wall = lerp(4, 420, smoothstep(8, 650, d)) * (0.55 + 0.45 * (0.5 + 0.5 * n.fbm(x * 0.0016, z * 0.0016, oct)));
      h = 0.25 + d * 0.22 + wall * smoothstep(0, 60, d) + n.fbm(x * 0.03, z * 0.03, dist < 300 ? 3 : 1) * 1.2 * smoothstep(0.5, 6, d) * (1 - smoothstep(150, 500, dist));
    }
    // the far ridge the river cuts through
    const far = smoothstep(-900, -2600, z) * 650 * (0.45 + 0.55 * (0.5 + 0.5 * n.fbm(x * 0.0007, z * 0.0007 + 3, 4)));
    const notch = 1 - 0.65 * Math.exp(-Math.pow((x - this.centre(-1800)) / 380, 2));
    h += far * notch;
    for (const b of this.boulders) {
      const r = Math.hypot(x - b.x, z - b.z);
      if (r < b.r * 1.3) h = Math.max(h, 0.25 + b.r * 0.55 * Math.sqrt(Math.max(0, 1 - (r / (b.r * 1.3)) ** 2)) - 0.6);
    }
    return h;
  }

  protected flow(x: number, z: number): [number, number] {
    const c = this.centre(z);
    const hw = this.halfWidth(z);
    const q = (x - c) / hw;
    if (Math.abs(q) >= 1) return [0, 0];
    const slope = (this.centre(z + 1) - this.centre(z - 1)) / 2;
    const len = Math.hypot(slope, 1);
    // narrower stretches run faster
    const v = FLOW_MAX * 0.85 * (1 - q * q) * clamp(8.5 / hw, 0.75, 1.15);
    let fx = (slope / len) * v;
    let fz = (1 / len) * v;
    // deflect around boulders
    for (const b of this.boulders) {
      const dx = x - b.x, dz = z - b.z;
      const r = Math.hypot(dx, dz);
      if (r < b.r * 2.2 && r > 0.01) {
        const k = (1 - r / (b.r * 2.2)) * v * 0.8;
        fx += (dx / r) * k;
        fz += (dz / r) * k * 0.3;
      }
    }
    return [fx, fz];
  }

  protected foam(x: number, z: number): number {
    let f = 0;
    for (const b of this.boulders) {
      const dx = x - b.x;
      const a = z - b.z; // downstream is +z
      const reach = Math.abs(dx) / (b.r * 1.15);
      if (reach > 1.6 || a < -b.r * 1.6 || a > b.r * 9) continue;
      const ring = Math.exp(-Math.pow((Math.hypot(dx, a) - b.r) / (b.r * 0.45), 2));
      const wake = a > 0 ? Math.exp(-reach * reach * 1.4) * Math.exp(-a / (b.r * 3.2)) : 0;
      f = Math.max(f, ring * 0.9 + wake * 0.75);
    }
    const hw = this.halfWidth(z);
    const edge = Math.abs(x - this.centre(z)) / hw;
    f = Math.max(f, smoothstep(0.82, 1.0, edge) * 0.25);
    return f;
  }

  protected paint(x: number, y: number, z: number, ny: number): [number, number, number, number] {
    const dx = Math.abs(x - this.centre(z)) - this.halfWidth(z);
    const forest = smoothstep(4, 16, dx) * smoothstep(0.5, 0.75, ny) * (1 - smoothstep(1500, 1900, y));
    const gravel = 1 - smoothstep(0.3, 2.2, dx);
    return [forest, 0, gravel, 0];
  }

  protected populate() {
    const veg = this.deps.tier.vegetation;
    const rnd = mulberry32(7);
    const rockMat = this.track(createLitMaterial({ kind: 'rock', moss: new Color(0.03, 0.055, 0.018), mossAmount: 0.9 }));

    // River boulders (their shape is also baked into the terrain and the foam).
    const inRiver: Placement[] = this.boulders.map((b) => {
      const g = 0.8 + rnd() * 0.3;
      return {
        x: b.x, y: -0.12, z: b.z, scale: [b.r, b.r * (0.75 + rnd() * 0.3), b.r * (0.9 + rnd() * 0.2)], rotY: rnd() * 6.28,
        color: new Color(0.17 * g, 0.165 * g, 0.15 * g),
      };
    });
    // Bank rocks, including the one the viewer stands beside.
    const bank: Placement[] = [{ x: -0.6, y: 0.2, z: -1.2, scale: [1.6, 1.1, 1.4], rotY: 0.6, color: new Color(0.16, 0.15, 0.14) }];
    for (let tries = 0; tries < 5000 && bank.length < 80; tries++) {
      const z = -2 - Math.pow(rnd(), 1.6) * 260;
      const c = this.centre(z), hw = this.halfWidth(z);
      const side = rnd() < 0.5 ? -1 : 1;
      const x = c + side * (hw + (rnd() - 0.2) * 5);
      const r = 0.4 + Math.pow(rnd(), 2.2) * 2;
      const g = 0.75 + rnd() * 0.35;
      bank.push({
        x, y: this.terrainHeight(x, z) - r * 0.3, z, scale: [r, r * (0.55 + rnd() * 0.4), r], rotY: rnd() * 6.28,
        color: new Color(0.16 * g, 0.155 * g, 0.14 * g),
      });
    }
    [21, 34].forEach((seed, i) => {
      const geo = this.track(createRockGeometry(seed));
      const all = [...inRiver, ...bank];
      this.add(createInstances(geo, rockMat, all.filter((_, k) => k % 2 === i)));
    });

    // Mixed forest on the valley sides.
    const conifers: Placement[] = [];
    const broad: Placement[] = [];
    const target = Math.round(3200 * veg);
    for (let tries = 0; tries < target * 10 && conifers.length + broad.length < target; tries++) {
      const dist = 14 * Math.pow(1300 / 14, rnd());
      const x = (rnd() * 2 - 1) * 1.25 * dist + 8;
      const z = -dist;
      const dx = Math.abs(x - this.centre(z)) - this.halfWidth(z);
      if (dx < 4 + rnd() * 4) continue;
      // keep a clearing around the viewer so the river stays in view
      if (Math.hypot(x, z) < 26 + rnd() * 10) continue;
      const y = this.terrainHeight(x, z);
      if (y > 1700) continue;
      const slope = Math.abs(this.terrainHeight(x + 2, z) - y) + Math.abs(this.terrainHeight(x, z + 2) - y);
      if (slope > 3.2) continue;
      if (this.noise.fbm(x * 0.006, z * 0.006 + 4, 2) < -0.45 + rnd() * 0.3) continue;
      const tint = 0.75 + rnd() * 0.5;
      const color = new Color(tint * (0.9 + rnd() * 0.2), tint, tint * (0.85 + rnd() * 0.2));
      if (rnd() < 0.55) {
        const h = 8 + rnd() * 10;
        broad.push({ x, y: y - 0.4, z, scale: [h * (0.9 + rnd() * 0.5), h, h * (0.9 + rnd() * 0.5)], rotY: rnd() * 6.28, color });
      } else {
        const h = 11 + rnd() * 14;
        conifers.push({ x, y: y - 0.4, z, scale: [h * 0.9, h, h * 0.9], rotY: rnd() * 6.28, color });
      }
    }
    const foliage = this.track(createLitMaterial({ kind: 'foliage', sway: 0.7 }));
    this.add(createInstances(this.track(createConiferGeometry(3)), foliage, conifers));
    this.add(createInstances(this.track(createBroadleafGeometry(5)), foliage, broad.filter((_, i) => i % 2 === 0)));
    this.add(createInstances(this.track(createBroadleafGeometry(8)), foliage, broad.filter((_, i) => i % 2 === 1)));

    this.fireflies = this.track(new Fireflies(Math.round(90 * Math.max(veg, 0.6)), (r) => {
      const z = -4 - r() * 55;
      const side = r() < 0.5 ? -1 : 1;
      const x = this.centre(z) + side * (this.halfWidth(z) + r() * 9);
      return [x, Math.max(this.terrainHeight(x, z), 0) + 0.4 + r() * 2.2, z];
    }));
    this.add(this.fireflies.points);
  }

  resize(width: number, height: number, drawW: number, drawH: number) {
    super.resize(width, height, drawW, drawH);
    this.pixelScale = drawH / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
  }

  protected onUpdate() {
    this.fireflies?.update(this.deps.env.night, this.pixelScale);
  }
}
