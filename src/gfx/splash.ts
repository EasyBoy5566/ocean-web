import {
  BufferGeometry, Float32BufferAttribute, NormalBlending, Points, ShaderMaterial, Vector3,
} from 'three';
import { GLOBALS, OUTPUT } from './glsl';
import { globals } from './globals';
import { mulberry32 } from '../util/math';

export interface EmitOptions {
  count: number;
  /** Horizontal speed range (m/s). */
  speed: [number, number];
  /** Vertical speed range (m/s). */
  up: [number, number];
  /** Spawn radius (m). */
  radius: number;
  size: [number, number];
  life: [number, number];
  /** Optional bias direction for the horizontal velocity. */
  bias?: Vector3;
  delay?: number;
}

/**
 * Water droplets thrown up by taps and stones. Simple ballistic particles on
 * the CPU (a few hundred at most), drawn as soft round point sprites lit by the
 * current sky and sun.
 */
export class Splash {
  readonly points: Points;
  private max: number;
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private size: Float32Array;
  private delay: Float32Array;
  private alpha: Float32Array;
  private sizeAttr: Float32Array;
  private next = 0;
  private rnd = mulberry32(99);
  private material: ShaderMaterial;
  /** Called when a droplet falls back into the water (x, z, size). */
  onLand: ((x: number, z: number, s: number) => void) | null = null;

  constructor(max = 700) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max).fill(1);
    this.size = new Float32Array(max);
    this.delay = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.sizeAttr = new Float32Array(max);
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('aAlpha', new Float32BufferAttribute(this.alpha, 1));
    geo.setAttribute('aSize', new Float32BufferAttribute(this.sizeAttr, 1));
    this.material = new ShaderMaterial({
      uniforms: { ...globals, uScale: { value: 800 } },
      vertexShader: /* glsl */ `
        attribute float aAlpha;
        attribute float aSize;
        uniform float uScale;
        varying float vAlpha;
        varying vec3 vWorld;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float px = aSize * uScale / max(-mv.z, 0.01);
          gl_PointSize = max(px, 1.5);
          vAlpha = aAlpha * min(px / 1.5, 1.0);
          vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        ${GLOBALS}
        varying float vAlpha;
        varying vec3 vWorld;
        void main() {
          vec2 c = gl_PointCoord * 2.0 - 1.0;
          float r = dot(c, c);
          if (r > 1.0 || vAlpha <= 0.0) discard;
          float a = (1.0 - r) * vAlpha;
          float hi = pow(max(1.0 - length(c - vec2(-0.3, -0.3)), 0.0), 6.0);
          vec3 col = uSkyAmbient * 1.6 + uSunColor * (0.55 + hi * 3.0) + uMoonColor * (0.6 + hi * 2.0);
          col = applyFog(col, vWorld);
          gl_FragColor = vec4(col, a * 0.85);
          ${OUTPUT}
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: NormalBlending,
    });
    this.points = new Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 20;
  }

  set pixelScale(v: number) {
    this.material.uniforms.uScale.value = v;
  }

  emit(origin: Vector3, o: EmitOptions) {
    const r = this.rnd;
    for (let n = 0; n < o.count; n++) {
      const i = this.next;
      this.next = (this.next + 1) % this.max;
      const a = r() * Math.PI * 2;
      const rad = Math.sqrt(r()) * o.radius;
      const sp = o.speed[0] + r() * (o.speed[1] - o.speed[0]);
      let vx = Math.cos(a) * sp;
      let vz = Math.sin(a) * sp;
      if (o.bias) {
        vx = vx * 0.5 + o.bias.x * sp;
        vz = vz * 0.5 + o.bias.z * sp;
      }
      this.pos[i * 3] = origin.x + Math.cos(a) * rad;
      this.pos[i * 3 + 1] = origin.y + 0.01;
      this.pos[i * 3 + 2] = origin.z + Math.sin(a) * rad;
      this.vel[i * 3] = vx;
      this.vel[i * 3 + 1] = o.up[0] + r() * (o.up[1] - o.up[0]);
      this.vel[i * 3 + 2] = vz;
      const life = o.life[0] + r() * (o.life[1] - o.life[0]);
      this.life[i] = life;
      this.maxLife[i] = life;
      this.size[i] = o.size[0] + r() * (o.size[1] - o.size[0]);
      this.delay[i] = (o.delay ?? 0) * (0.7 + r() * 0.6);
    }
  }

  /** Splash presets. `energy` is roughly 0..1. */
  burst(kind: 'tap' | 'plunge' | 'skip', p: Vector3, energy = 0.5, dir?: Vector3) {
    if (kind === 'tap') {
      this.emit(p, { count: 26, speed: [0.3, 1.4], up: [1.2, 3.0], radius: 0.06, size: [0.008, 0.02], life: [0.6, 1.1] });
      this.emit(p, { count: 10, speed: [0.05, 0.3], up: [2.2, 3.6], radius: 0.02, size: [0.012, 0.024], life: [0.8, 1.2], delay: 0.12 });
    } else if (kind === 'plunge') {
      const e = 0.6 + energy;
      this.emit(p, { count: Math.round(40 * e), speed: [0.6 * e, 2.2 * e], up: [1.5 * e, 3.6 * e], radius: 0.1, size: [0.01, 0.03], life: [0.7, 1.3] });
      this.emit(p, { count: Math.round(18 * e), speed: [0.02, 0.25], up: [3.0 * e, 4.8 * e], radius: 0.03, size: [0.015, 0.035], life: [1.0, 1.5], delay: 0.16 });
    } else {
      const bias = dir ? dir.clone().setY(0).normalize() : undefined;
      this.emit(p, { count: 14, speed: [0.5, 1.8], up: [0.6, 1.8], radius: 0.05, size: [0.008, 0.018], life: [0.4, 0.8], bias });
    }
  }

  update(dt: number, waterHeight: (x: number, z: number) => number) {
    const g = 9.81;
    let any = false;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        continue;
      }
      if (this.delay[i] > 0) {
        this.delay[i] -= dt;
        this.alpha[i] = 0;
        any = true;
        continue;
      }
      any = true;
      const k = i * 3;
      this.vel[k + 1] -= g * dt;
      const drag = Math.exp(-dt * 0.6);
      this.vel[k] *= drag;
      this.vel[k + 2] *= drag;
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] += this.vel[k + 1] * dt;
      this.pos[k + 2] += this.vel[k + 2] * dt;
      this.life[i] -= dt;
      const wy = waterHeight(this.pos[k], this.pos[k + 2]);
      if (this.vel[k + 1] < 0 && this.pos[k + 1] < wy) {
        this.life[i] = 0;
        this.onLand?.(this.pos[k], this.pos[k + 2], this.size[i]);
      }
      const t = this.life[i] / this.maxLife[i];
      this.alpha[i] = Math.max(0, Math.min(1, t * 3));
      this.sizeAttr[i] = this.size[i];
    }
    const geo = this.points.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.aAlpha.needsUpdate = true;
    geo.attributes.aSize.needsUpdate = true;
    this.points.visible = any;
  }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}

