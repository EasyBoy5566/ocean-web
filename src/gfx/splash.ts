import {
  BufferGeometry, CylinderGeometry, DoubleSide, DynamicDrawUsage, Float32BufferAttribute, InstancedBufferAttribute,
  InstancedBufferGeometry, Mesh, NormalBlending, Points, ShaderMaterial, Vector2, Vector3, type Object3D,
} from 'three';
import { mulberry32 } from '../util/math';
import { LAYER_SURFACE } from './composite';
import { APPARENT, GLOBALS, OUTPUT } from './glsl';
import { globals } from './globals';

export interface EmitOptions {
  count: number;
  /** Horizontal speed range (m/s). */
  speed: [number, number];
  /** Vertical speed range (m/s). */
  up: [number, number];
  /** Spawn radius (m). */
  radius: number;
  /** Droplet radius range (m). */
  size: [number, number];
  life: [number, number];
  /** Optional bias direction for the horizontal velocity. */
  bias?: Vector3;
  delay?: number;
}

// Splashes are drawn over the water but kept out of its reflection: mirrored in
// rippled water they would read as flat white shapes.
const onSurface = (o: Object3D) => {
  o.layers.set(LAYER_SURFACE);
  o.frustumCulled = false;
};

/**
 * Airborne water: droplets drawn as quads stretched along their screen-space
 * velocity, which reads as motion blur (a real camera never sees round dots).
 */
class Droplets {
  readonly mesh: Mesh;
  private max: number;
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private size: Float32Array;
  private delay: Float32Array;
  private aPos: InstancedBufferAttribute;
  private aVel: InstancedBufferAttribute;
  private aSize: InstancedBufferAttribute;
  private aAlpha: InstancedBufferAttribute;
  private next = 0;
  private rnd = mulberry32(99);
  readonly material: ShaderMaterial;
  onLand: ((x: number, z: number, s: number) => void) | null = null;

  constructor(max = 900) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max).fill(1);
    this.size = new Float32Array(max);
    this.delay = new Float32Array(max);
    const geo = new InstancedBufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const mk = (n: number) => new InstancedBufferAttribute(new Float32Array(max * n), n).setUsage(DynamicDrawUsage);
    this.aPos = mk(3);
    this.aVel = mk(3);
    this.aSize = mk(1);
    this.aAlpha = mk(1);
    geo.setAttribute('iPos', this.aPos);
    geo.setAttribute('iVel', this.aVel);
    geo.setAttribute('iSize', this.aSize);
    geo.setAttribute('iAlpha', this.aAlpha);
    geo.instanceCount = max;
    this.material = new ShaderMaterial({
      uniforms: { ...globals, uStretch: { value: 1 / 45 }, uViewport: { value: new Vector2(800, 800) } },
      vertexShader: /* glsl */ `
        attribute vec3 iPos;
        attribute vec3 iVel;
        attribute float iSize;
        attribute float iAlpha;
        uniform float uStretch;
        uniform vec2 uViewport;
        varying vec2 vUv;
        varying float vAlpha;
        varying vec3 vWorld;
        void main() {
          vUv = position.xy;
          vWorld = iPos;
          vAlpha = iAlpha;
          if (iAlpha <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          vec4 c0 = projectionMatrix * viewMatrix * vec4(iPos, 1.0);
          vec4 c1 = projectionMatrix * viewMatrix * vec4(iPos - iVel * uStretch, 1.0);
          vec2 half_ = uViewport * 0.5;
          vec2 s0 = c0.xy / c0.w * half_;
          vec2 s1 = c1.xy / max(c1.w, 1e-3) * half_;
          vec2 d = s0 - s1;
          float len = length(d);
          vec2 ax = len > 0.01 ? d / len : vec2(0.0, 1.0);
          vec2 sd = vec2(-ax.y, ax.x);
          float rad = iSize * projectionMatrix[1][1] / c0.w * half_.y;
          // keep sub-pixel drops visible but faint instead of flickering
          vAlpha *= clamp(rad / 0.8, 0.15, 1.0) * clamp((2.0 * rad + 1.0) / (2.0 * rad + 1.0 + len * 0.6), 0.3, 1.0);
          rad = max(rad, 0.8);
          vec2 px = (s0 + s1) * 0.5 + sd * position.x * rad + ax * position.y * (rad + len * 0.5);
          gl_Position = vec4(px / half_ * c0.w, c0.z, c0.w);
        }
      `,
      fragmentShader: /* glsl */ `
        ${GLOBALS}
        varying vec2 vUv;
        varying float vAlpha;
        varying vec3 vWorld;
        void main() {
          float r = length(vUv);
          if (r > 1.0) discard;
          float a = (1.0 - r * r) * vAlpha;
          // a droplet mirrors the bright sky and catches the sun
          vec3 col = uSkyAmbient * 1.7 + uSunColor * 0.75 + uMoonColor * 0.9;
          col = applyFog(col, vWorld);
          gl_FragColor = vec4(col, a * 0.9);
          ${OUTPUT}
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: NormalBlending,
    });
    this.mesh = new Mesh(geo, this.material);
    this.mesh.renderOrder = 20;
    onSurface(this.mesh);
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
        vx = vx * 0.45 + o.bias.x * sp;
        vz = vz * 0.45 + o.bias.z * sp;
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
      this.size[i] = o.size[0] + Math.pow(r(), 2) * (o.size[1] - o.size[0]);
      this.delay[i] = (o.delay ?? 0) * (0.8 + r() * 0.4);
    }
  }

  update(dt: number, waterHeight: (x: number, z: number) => number) {
    let any = false;
    const P = this.aPos.array as Float32Array;
    const Vv = this.aVel.array as Float32Array;
    const S = this.aSize.array as Float32Array;
    const A = this.aAlpha.array as Float32Array;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0 || this.delay[i] > 0) {
        if (this.delay[i] > 0) {
          this.delay[i] -= dt;
          any = true;
        }
        A[i] = 0;
        continue;
      }
      any = true;
      const k = i * 3;
      // air drag is stronger for small drops
      const drag = Math.exp(-dt * (0.25 + 0.004 / Math.max(this.size[i], 0.001)));
      this.vel[k] *= drag;
      this.vel[k + 2] *= drag;
      this.vel[k + 1] = this.vel[k + 1] * drag - 9.81 * dt;
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] += this.vel[k + 1] * dt;
      this.pos[k + 2] += this.vel[k + 2] * dt;
      this.life[i] -= dt;
      if (this.vel[k + 1] < 0 && this.pos[k + 1] < waterHeight(this.pos[k], this.pos[k + 2])) {
        this.life[i] = 0;
        this.onLand?.(this.pos[k], this.pos[k + 2], this.size[i]);
      }
      P[k] = this.pos[k];
      P[k + 1] = this.pos[k + 1];
      P[k + 2] = this.pos[k + 2];
      Vv[k] = this.vel[k];
      Vv[k + 1] = this.vel[k + 1];
      Vv[k + 2] = this.vel[k + 2];
      S[i] = this.size[i];
      A[i] = Math.min(1, (this.life[i] / this.maxLife[i]) * 4);
    }
    this.aPos.needsUpdate = this.aVel.needsUpdate = this.aSize.needsUpdate = this.aAlpha.needsUpdate = true;
    this.mesh.visible = any;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

interface Sheet {
  mesh: Mesh;
  mat: ShaderMaterial;
  age: number;
  life: number;
  active: boolean;
}

const SHEET_VERT = /* glsl */ `
uniform float uAge;
uniform float uR;
uniform float uH;
uniform float uSeed;
uniform float uMode;
varying vec3 vWorld;
varying vec3 vN;
varying float vV;
void main() {
  float v = position.y + 0.5;
  float a = atan(position.z, position.x);
  float t = uAge;
  vec3 p;
  if (uMode < 0.5) {
    // crown: a thin sheet thrown up and outwards, its rim breaking into fingers
    float grow = 1.0 - pow(1.0 - t, 3.0);
    float fingers = pow(clamp(0.5 + 0.5 * sin(a * 13.0 + uSeed) + 0.25 * sin(a * 29.0 - uSeed * 1.7), 0.0, 1.0), 2.0);
    float h = uH * sin(min(t * 1.5, 1.0) * 3.14159) * (0.7 + 0.5 * fingers * smoothstep(0.6, 1.0, v));
    float r = uR * (0.35 + 0.95 * grow) * (1.0 + v * (0.25 + 0.5 * grow));
    p = vec3(cos(a) * r, v * h, sin(a) * r);
  } else {
    // Worthington jet: a column that shoots up from the collapsing cavity and falls back
    float h = uH * sin(clamp(t, 0.0, 1.0) * 3.14159);
    float taper = mix(1.0, 0.45, v) * (1.0 - 0.6 * pow(v, 6.0));
    float r = uR * taper * (0.8 + 0.4 * (1.0 - t));
    p = vec3(cos(a) * r, v * h, sin(a) * r);
  }
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  vN = normalize(vec3(cos(a), uMode < 0.5 ? 0.35 : 0.0, sin(a)));
  vV = v;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SHEET_FRAG = /* glsl */ `
${GLOBALS}
uniform float uAge;
uniform float uMode;
varying vec3 vWorld;
varying vec3 vN;
varying float vV;
void main() {
  vec3 V = normalize(cameraPosition - vWorld);
  float facing = abs(dot(normalize(vN), V));
  float fres = pow(1.0 - facing, 2.0);
  float fade = pow(1.0 - uAge, 1.3);
  float a = (0.18 + 0.7 * fres) * fade * smoothstep(0.0, 0.12, vV);
  if (uMode < 0.5) a *= 1.0 - 0.6 * smoothstep(0.75, 1.0, vV);
  else a = (0.45 + 0.4 * fres) * fade;
  vec3 col = uSkyAmbient * 1.6 + uSunColor * (0.55 + 0.8 * fres) + uMoonColor * 0.8;
  col = applyFog(col, vWorld);
  gl_FragColor = vec4(col, a);
  ${OUTPUT}
}
`;

/** Pool of short-lived water sheets (crowns) and columns (jets). */
class Sheets {
  readonly group: Object3D[] = [];
  private items: Sheet[] = [];
  private geo = new CylinderGeometry(1, 1, 1, 40, 6, true);

  constructor(count = 10) {
    for (let i = 0; i < count; i++) {
      // one material each: every sheet animates with its own uniforms (same compiled program)
      const mat = new ShaderMaterial({
        uniforms: { ...globals, uAge: { value: 0 }, uR: { value: 0.1 }, uH: { value: 0.1 }, uSeed: { value: 0 }, uMode: { value: 0 } },
        vertexShader: SHEET_VERT,
        fragmentShader: SHEET_FRAG,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
      });
      const mesh = new Mesh(this.geo, mat);
      mesh.visible = false;
      mesh.renderOrder = 19;
      onSurface(mesh);
      this.items.push({ mesh, mat, age: 0, life: 1, active: false });
      this.group.push(mesh);
    }
  }

  spawn(mode: 'crown' | 'jet', at: Vector3, radius: number, height: number, life: number) {
    const s = this.items.find((x) => !x.active) ?? this.items[0];
    s.active = true;
    s.age = 0;
    s.life = life;
    s.mesh.position.copy(at);
    s.mesh.visible = true;
    const u = s.mat.uniforms;
    u.uMode.value = mode === 'crown' ? 0 : 1;
    u.uR.value = radius;
    u.uH.value = height;
    u.uSeed.value = Math.random() * 10;
    u.uAge.value = 0;
  }

  update(dt: number, waterHeight: (x: number, z: number) => number) {
    for (const s of this.items) {
      if (!s.active) continue;
      s.age += dt;
      const t = s.age / s.life;
      if (t >= 1) {
        s.active = false;
        s.mesh.visible = false;
        continue;
      }
      s.mat.uniforms.uAge.value = t;
      s.mesh.position.y = waterHeight(s.mesh.position.x, s.mesh.position.z) - 0.005;
    }
  }

  dispose() {
    this.geo.dispose();
    this.items.forEach((s) => s.mat.dispose());
  }
}

/** Air bubbles rising through the water after a splash; seen through the refracting surface. */
class Bubbles {
  readonly points: Points;
  private max: number;
  private pos: Float32Array;
  private seed: Float32Array;
  private alpha: Float32Array;
  private life: Float32Array;
  private speed: Float32Array;
  private next = 0;
  private rnd = mulberry32(3);
  private material: ShaderMaterial;
  onPop: ((x: number, z: number) => void) | null = null;

  constructor(max = 300) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.seed = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.life = new Float32Array(max);
    this.speed = new Float32Array(max);
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage));
    geo.setAttribute('aAlpha', new Float32BufferAttribute(this.alpha, 1).setUsage(DynamicDrawUsage));
    geo.setAttribute('aSeed', new Float32BufferAttribute(this.seed, 1));
    this.material = new ShaderMaterial({
      uniforms: { ...globals, uScale: { value: 800 } },
      vertexShader: /* glsl */ `
        ${APPARENT}
        attribute float aAlpha;
        attribute float aSeed;
        uniform float uScale;
        varying float vAlpha;
        varying vec3 vWorld;
        void main() {
          vec4 mv = viewMatrix * vec4(apparentPosition(position), 1.0);
          float size = (0.004 + 0.01 * aSeed) * uScale / max(-mv.z, 0.01);
          gl_PointSize = max(size, 1.5);
          vAlpha = aAlpha * min(size / 1.5, 1.0);
          vWorld = position;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        ${GLOBALS}
        varying float vAlpha;
        varying vec3 vWorld;
        void main() {
          vec2 c = gl_PointCoord * 2.0 - 1.0;
          float r = length(c);
          if (r > 1.0 || vAlpha <= 0.0) discard;
          float rim = smoothstep(0.55, 0.95, r) * (1.0 - smoothstep(0.95, 1.0, r));
          float hi = smoothstep(0.35, 0.0, length(c - vec2(-0.35, 0.35)));
          vec3 col = (uSkyAmbient * 2.0 + uSunColor * 0.8 + uMoonColor) * (rim + hi * 1.5);
          col = applyUnderwater(col, vWorld);
          gl_FragColor = vec4(col, (rim * 0.7 + hi) * vAlpha);
          ${OUTPUT}
        }
      `,
      transparent: true,
      depthWrite: false,
    });
    this.points = new Points(geo, this.material);
    this.points.frustumCulled = false;
  }

  set pixelScale(v: number) {
    this.material.uniforms.uScale.value = v;
  }

  emit(at: Vector3, count: number, spread: number) {
    const r = this.rnd;
    for (let n = 0; n < count; n++) {
      const i = this.next;
      this.next = (this.next + 1) % this.max;
      this.pos[i * 3] = at.x + (r() - 0.5) * spread;
      this.pos[i * 3 + 1] = Math.min(at.y, -0.03) - r() * spread * 0.5;
      this.pos[i * 3 + 2] = at.z + (r() - 0.5) * spread;
      this.seed[i] = r();
      this.speed[i] = 0.18 + 0.3 * this.seed[i];
      this.life[i] = 6;
      this.alpha[i] = 1;
    }
    this.points.geometry.attributes.aSeed.needsUpdate = true;
  }

  update(dt: number, waterHeight: (x: number, z: number) => number, time: number) {
    let any = false;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        continue;
      }
      any = true;
      const k = i * 3;
      this.life[i] -= dt;
      this.pos[k + 1] += this.speed[i] * dt;
      this.pos[k] += Math.sin(time * 9 + i) * 0.06 * dt;
      this.pos[k + 2] += Math.cos(time * 7.3 + i * 1.7) * 0.06 * dt;
      if (this.pos[k + 1] >= waterHeight(this.pos[k], this.pos[k + 2]) - 0.01) {
        this.life[i] = 0;
        this.alpha[i] = 0;
        this.onPop?.(this.pos[k], this.pos[k + 2]);
        continue;
      }
      this.alpha[i] = Math.min(1, this.life[i]);
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
    this.points.visible = any;
  }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}

/** Everything a splash throws up, choreographed over its first second. */
export class SplashFX {
  private droplets = new Droplets();
  private sheets = new Sheets();
  readonly bubbles = new Bubbles();
  private queue: { at: number; fn: () => void }[] = [];
  private clock = 0;

  get objects(): Object3D[] {
    return [this.droplets.mesh, ...this.sheets.group, this.bubbles.points];
  }

  set onLand(f: ((x: number, z: number, s: number) => void) | null) {
    this.droplets.onLand = f;
  }

  set onPop(f: ((x: number, z: number) => void) | null) {
    this.bubbles.onPop = f;
  }

  setViewport(width: number, height: number, pixelScale: number) {
    this.droplets.material.uniforms.uViewport.value.set(width, height);
    this.bubbles.pixelScale = pixelScale;
  }

  private later(delay: number, fn: () => void) {
    this.queue.push({ at: this.clock + delay, fn });
  }

  emit(at: Vector3, o: EmitOptions) {
    this.droplets.emit(at, o);
  }

  /** A fingertip striking the water. */
  tap(p: Vector3, onSecond: (p: Vector3) => void) {
    this.sheets.spawn('crown', p, 0.035, 0.05, 0.3);
    this.droplets.emit(p, { count: 22, speed: [0.25, 1.1], up: [0.9, 2.2], radius: 0.04, size: [0.0015, 0.005], life: [0.4, 0.9] });
    const q = p.clone();
    this.later(0.12, () => {
      this.sheets.spawn('jet', q, 0.009, 0.12, 0.38);
      this.droplets.emit(q, { count: 3, speed: [0.0, 0.08], up: [2.0, 2.7], radius: 0.004, size: [0.004, 0.006], life: [0.6, 0.8] });
    });
    this.later(0.5, () => onSecond(q));
    this.bubbles.emit(p, 6, 0.05);
  }

  /** A stone plunging in. `energy` is 0..1 from impact speed. */
  plunge(p: Vector3, energy: number, onSecond: (p: Vector3) => void) {
    const e = 0.4 + energy * 0.8;
    this.sheets.spawn('crown', p, 0.06 + 0.05 * e, 0.07 + 0.12 * e, 0.42 + 0.1 * e);
    this.droplets.emit(p, { count: Math.round(70 * e), speed: [0.5 * e, 2.2 * e], up: [1.2 * e, 3.0 * e], radius: 0.07, size: [0.003, 0.012], life: [0.5, 1.1] });
    this.droplets.emit(p, { count: Math.round(25 * e), speed: [0.2, 0.9], up: [0.4, 1.4], radius: 0.05, size: [0.001, 0.0025], life: [0.4, 0.8] });
    const q = p.clone();
    this.later(0.17, () => {
      this.sheets.spawn('jet', q, 0.018 + 0.012 * e, 0.12 + 0.2 * e, 0.5 + 0.12 * e);
      this.droplets.emit(q, { count: Math.round(5 + 5 * e), speed: [0.0, 0.25], up: [2.4 * e, 3.6 * e], radius: 0.01, size: [0.006, 0.012], life: [0.8, 1.2] });
    });
    this.later(0.62, () => onSecond(q));
    this.bubbles.emit(p, Math.round(18 + 18 * e), 0.18);
  }

  /** A skipping stone kissing the surface: a low fan of spray thrown forward. */
  skip(p: Vector3, energy: number, dir: Vector3) {
    const bias = dir.clone().setY(0).normalize();
    this.sheets.spawn('crown', p, 0.05, 0.035 + 0.02 * energy, 0.25);
    this.droplets.emit(p, { count: 16, speed: [0.6, 2.2], up: [0.5, 1.5], radius: 0.04, size: [0.0015, 0.006], life: [0.35, 0.7], bias });
  }

  update(dt: number, waterHeight: (x: number, z: number) => number, time: number) {
    this.clock += dt;
    if (this.queue.length) {
      const due = this.queue.filter((q) => q.at <= this.clock);
      this.queue = this.queue.filter((q) => q.at > this.clock);
      due.forEach((q) => q.fn());
    }
    this.droplets.update(dt, waterHeight);
    this.sheets.update(dt, waterHeight);
    this.bubbles.update(dt, waterHeight, time);
  }

  dispose() {
    this.droplets.dispose();
    this.sheets.dispose();
    this.bubbles.dispose();
  }
}
