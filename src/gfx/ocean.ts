import {
  DataTexture, FloatType, GLSL3, HalfFloatType, LinearFilter, LinearMipmapLinearFilter, NearestFilter,
  RawShaderMaterial, RepeatWrapping, RGBAFormat, Vector3, WebGLRenderTarget, type Texture, type WebGLRenderer,
} from 'three';
import { mulberry32 } from '../util/math';
import { FullscreenPass } from './fullscreen';

/**
 * Spectral ocean after Tessendorf ("Simulating Ocean Water"): a JONSWAP wind
 * sea plus a long-period swell are synthesised in the frequency domain and
 * brought to the spatial domain with an inverse FFT every frame, in three
 * cascades from long swell to centimetre ripples. The FFT runs as fragment
 * passes (Stockham radix-2), so it works on any WebGL2 device.
 *
 * Each cascade yields two mipmapped textures:
 *   disp  = (Dx, height, Dz, foam)      choppy displacement + accumulated foam
 *   deriv = (dh/dx, dh/dz, dDx/dx, dDz/dz)
 */

export interface SeaState {
  /** Wind speed 10 m above the sea (m/s) and its direction of travel in world XZ. */
  windSpeed: number;
  windDir: [number, number];
  /** Distance over which the wind has blown (m). */
  fetch: number;
  /** Long-period swell from a distant storm. */
  swellHeight: number;
  swellPeriod: number;
  swellDir: [number, number];
  /** Horizontal choppiness (sharpens crests). */
  choppiness: number;
}

const G = 9.81;
const SURFACE_TENSION = 7.28e-5;
const dispersion = (k: number) => Math.sqrt(G * k + SURFACE_TENSION * k * k * k);
const dispersionDeriv = (k: number) => (G + 3 * SURFACE_TENSION * k * k) / (2 * dispersion(k));

function jonswapShape(omega: number, omegaP: number, gamma: number) {
  const sigma = omega <= omegaP ? 0.07 : 0.09;
  const r = Math.exp(-((omega - omegaP) ** 2) / (2 * sigma * sigma * omegaP * omegaP));
  return (G * G / omega ** 5) * Math.exp(-1.25 * (omegaP / omega) ** 4) * Math.pow(gamma, r);
}

/** Mitsuyasu-type spreading cos^2s(θ/2), normalised numerically. */
function spreading(theta: number, s: number, norm: number) {
  return norm * Math.pow(Math.abs(Math.cos(theta / 2)), 2 * s);
}
const normCache = new Map<number, number>();
function spreadNorm(s: number) {
  const key = Math.round(s * 100) / 100;
  let n = normCache.get(key);
  if (n === undefined) {
    let sum = 0;
    const steps = 512;
    for (let i = 0; i < steps; i++) {
      const th = -Math.PI + ((i + 0.5) / steps) * 2 * Math.PI;
      sum += Math.pow(Math.abs(Math.cos(th / 2)), 2 * key) * ((2 * Math.PI) / steps);
    }
    n = 1 / sum;
    normCache.set(key, n);
  }
  return n;
}

/** Directional sea spectrum S(kx, kz) (m^4) = wind sea + swell. */
function makeSpectrum(sea: SeaState) {
  const U = sea.windSpeed, F = sea.fetch;
  const wP = 22 * Math.pow((G * G) / (U * F), 1 / 3);
  const alpha = 0.076 * Math.pow((U * U) / (F * G), 0.22);
  const windAng = Math.atan2(sea.windDir[0], sea.windDir[1]);
  // swell: scale a narrow JONSWAP so its significant height matches swellHeight
  const sP = (2 * Math.PI) / sea.swellPeriod;
  let m0 = 0;
  for (let i = 1; i < 4000; i++) {
    const w = i * 0.001;
    m0 += jonswapShape(w, sP, 7) * 0.001;
  }
  const swellAlpha = (sea.swellHeight / 4) ** 2 / m0;
  const swellAng = Math.atan2(sea.swellDir[0], sea.swellDir[1]);
  return (kx: number, kz: number) => {
    const k = Math.hypot(kx, kz);
    if (k < 1e-6) return 0;
    const w = dispersion(k);
    const theta = Math.atan2(kx, kz);
    const jac = dispersionDeriv(k) / k;
    // wind sea, spreading narrower near the peak (Mitsuyasu)
    const ratio = w / wP;
    const s = 10 * (ratio < 1 ? Math.pow(ratio, 5) : Math.pow(ratio, -2.5));
    const sWind = Math.max(s, 1);
    const wind = alpha * jonswapShape(w, wP, 3.3) * spreading(theta - windAng, sWind, spreadNorm(sWind));
    const swell = swellAlpha * jonswapShape(w, sP, 7) * spreading(theta - swellAng, 40, spreadNorm(40));
    // tiny ripples are damped by viscosity
    const damp = Math.exp(-k * k * 0.0004 * 0.0004 * 1e2);
    return (wind + swell) * jac * damp;
  };
}

function gaussian(rnd: () => number): [number, number] {
  const u = Math.max(rnd(), 1e-9), v = rnd();
  const r = Math.sqrt(-2 * Math.log(u));
  return [r * Math.cos(2 * Math.PI * v), r * Math.sin(2 * Math.PI * v)];
}

interface Mode {
  kx: number;
  kz: number;
  w: number;
  /** h0(k) and conj(h0(-k)) */
  ar: number;
  ai: number;
  br: number;
  bi: number;
}

const VERT = /* glsl */ `
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const COMMON = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
`;

const SPECTRUM_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D uH0;
uniform float uTime;
uniform float uL;
uniform int uN;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
void main() {
  ivec2 id = ivec2(gl_FragCoord.xy);
  vec2 k = 6.283185307 * (vec2(id) - float(uN / 2)) / uL;
  float kl = length(k);
  if (kl < 1e-6) { o0 = vec4(0.0); o1 = vec4(0.0); return; }
  vec4 h0 = texelFetch(uH0, id, 0);
  float w = sqrt(9.81 * kl + 7.28e-5 * kl * kl * kl);
  float ph = w * uTime;
  vec2 e = vec2(cos(ph), sin(ph));
  // h0(k) runs along +k, conj(h0(-k)) along -k
  vec2 h = cmul(h0.xy, vec2(e.x, -e.y)) + cmul(h0.zw, e);
  vec2 ih = vec2(-h.y, h.x);
  vec2 dx = ih * (k.x / kl);
  vec2 dz = ih * (k.y / kl);
  vec2 hx = ih * k.x;
  vec2 hz = ih * k.y;
  vec2 dxx = -h * (k.x * k.x / kl);
  vec2 dzz = -h * (k.y * k.y / kl);
  vec2 dxz = -h * (k.x * k.y / kl);
  // two real fields per complex channel: A + iB
  o0 = vec4(dx.x - dz.y, dx.y + dz.x, h.x - dxx.y, h.y + dxx.x);
  o1 = vec4(hx.x - hz.y, hx.y + hz.x, dzz.x - dxz.y, dzz.y + dxz.x);
}
`;

const FFT_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D uIn0;
uniform sampler2D uIn1;
uniform int uNs;
uniform int uHorizontal;
uniform int uN;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
void main() {
  ivec2 id = ivec2(gl_FragCoord.xy);
  int o = uHorizontal == 1 ? id.x : id.y;
  int q = o % (2 * uNs);
  int base = (o / (2 * uNs)) * uNs;
  bool plus = q < uNs;
  int k = plus ? q : q - uNs;
  int j = base + k;
  ivec2 ia = uHorizontal == 1 ? ivec2(j, id.y) : ivec2(id.x, j);
  ivec2 ib = uHorizontal == 1 ? ivec2(j + uN / 2, id.y) : ivec2(id.x, j + uN / 2);
  float ang = 3.14159265359 * float(k) / float(uNs);
  vec2 tw = vec2(cos(ang), sin(ang));
  vec4 a0 = texelFetch(uIn0, ia, 0);
  vec4 b0 = texelFetch(uIn0, ib, 0);
  vec4 a1 = texelFetch(uIn1, ia, 0);
  vec4 b1 = texelFetch(uIn1, ib, 0);
  vec4 t0 = vec4(cmul(b0.xy, tw), cmul(b0.zw, tw));
  vec4 t1 = vec4(cmul(b1.xy, tw), cmul(b1.zw, tw));
  o0 = plus ? a0 + t0 : a0 - t0;
  o1 = plus ? a1 + t1 : a1 - t1;
}
`;

const ASSEMBLE_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D uIn0;
uniform sampler2D uIn1;
uniform sampler2D uPrev;
uniform float uChop;
uniform float uFoamDecay;
uniform float uFoamBias;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
void main() {
  ivec2 id = ivec2(gl_FragCoord.xy);
  // the spectrum was centred, which flips the sign of every other sample
  float s = ((id.x + id.y) & 1) == 0 ? 1.0 : -1.0;
  vec4 a = texelFetch(uIn0, id, 0) * s;
  vec4 b = texelFetch(uIn1, id, 0) * s;
  float dxx = a.w * uChop;
  float dzz = b.z * uChop;
  float dxz = b.w * uChop;
  float jac = (1.0 + dxx) * (1.0 + dzz) - dxz * dxz;
  float prev = texelFetch(uPrev, id, 0).w;
  // whitecaps where the surface folds over; they linger and fade
  float foam = max(prev * uFoamDecay, clamp((uFoamBias - jac) * 1.6, 0.0, 1.0));
  o0 = vec4(a.x * uChop, a.z, a.y * uChop, foam);
  o1 = vec4(b.x, b.y, dxx, dzz);
}
`;

interface Cascade {
  L: number;
  h0: DataTexture;
  spec: WebGLRenderTarget;
  ping: WebGLRenderTarget;
  pong: WebGLRenderTarget;
  out: [WebGLRenderTarget, WebGLRenderTarget];
  current: number;
}

/** Band each cascade covers (rad/m) so no wavelength is counted twice. */
const BANDS: [number, number][] = [[0, 1.6], [1.6, 12], [12, 1e9]];
export const CASCADE_LENGTHS = [250, 37, 7.3];

export class FFTOcean {
  readonly N: number;
  readonly lengths = new Vector3(...CASCADE_LENGTHS);
  readonly choppiness: number;
  private cascades: Cascade[] = [];
  private pass = new FullscreenPass();
  private specMat: RawShaderMaterial;
  private fftMat: RawShaderMaterial;
  private asmMat: RawShaderMaterial;
  /** The largest modes, evaluated directly on the CPU for picking and physics. */
  private modes: Mode[] = [];

  constructor(sea: SeaState, N: number) {
    this.N = N;
    this.choppiness = sea.choppiness;
    const S = makeSpectrum(sea);
    const rnd = mulberry32(1337);
    const all: Mode[] = [];
    CASCADE_LENGTHS.forEach((L, c) => {
      const dk = (2 * Math.PI) / L;
      const [kmin, kmax] = BANDS[c];
      const amp = new Float32Array(N * N * 2);
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const kx = (i - N / 2) * dk, kz = (j - N / 2) * dk;
          const k = Math.hypot(kx, kz);
          const [gr, gi] = gaussian(rnd);
          let a = 0;
          if (k >= kmin && k < kmax) a = Math.sqrt((S(kx, kz) * dk * dk) / 2) / Math.SQRT2;
          amp[(j * N + i) * 2] = gr * a;
          amp[(j * N + i) * 2 + 1] = gi * a;
        }
      }
      const data = new Float32Array(N * N * 4);
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const o = (j * N + i) * 4;
          const mi = (N - i) % N, mj = (N - j) % N;
          const m = (mj * N + mi) * 2;
          data[o] = amp[(j * N + i) * 2];
          data[o + 1] = amp[(j * N + i) * 2 + 1];
          data[o + 2] = amp[m];
          data[o + 3] = -amp[m + 1];
          if (c < 2) {
            const kx = (i - N / 2) * dk, kz = (j - N / 2) * dk;
            const mag = Math.hypot(data[o], data[o + 1]) + Math.hypot(data[o + 2], data[o + 3]);
            if (mag > 0) all.push({ kx, kz, w: dispersion(Math.hypot(kx, kz)), ar: data[o], ai: data[o + 1], br: data[o + 2], bi: data[o + 3] });
          }
        }
      }
      const h0 = new DataTexture(data, N, N, RGBAFormat, FloatType);
      h0.minFilter = h0.magFilter = NearestFilter;
      h0.needsUpdate = true;
      const work = () => new WebGLRenderTarget(N, N, {
        count: 2, type: HalfFloatType, minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: false, generateMipmaps: false,
      });
      const outRT = () => {
        const rt = new WebGLRenderTarget(N, N, {
          count: 2, type: HalfFloatType, minFilter: LinearMipmapLinearFilter, magFilter: LinearFilter,
          wrapS: RepeatWrapping, wrapT: RepeatWrapping, depthBuffer: false, generateMipmaps: true,
        });
        rt.textures.forEach((t) => {
          t.wrapS = t.wrapT = RepeatWrapping;
          t.minFilter = LinearMipmapLinearFilter;
          t.magFilter = LinearFilter;
          t.generateMipmaps = true;
          t.anisotropy = 4;
        });
        return rt;
      };
      this.cascades.push({ L, h0, spec: work(), ping: work(), pong: work(), out: [outRT(), outRT()], current: 0 });
    });
    // keep the strongest long waves for CPU queries; pair each with its mirror only once
    all.sort((a, b) => Math.hypot(b.ar, b.ai) + Math.hypot(b.br, b.bi) - (Math.hypot(a.ar, a.ai) + Math.hypot(a.br, a.bi)));
    const seen = new Set<string>();
    for (const m of all) {
      const key = `${m.kx.toFixed(5)},${m.kz.toFixed(5)}`;
      const mirror = `${(-m.kx).toFixed(5)},${(-m.kz).toFixed(5)}`;
      if (seen.has(key) || seen.has(mirror)) continue;
      seen.add(key);
      this.modes.push(m);
      if (this.modes.length >= 72) break;
    }

    const raw = (frag: string, uniforms: Record<string, { value: unknown }>) =>
      new RawShaderMaterial({ glslVersion: GLSL3, vertexShader: VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false });
    this.specMat = raw(SPECTRUM_FRAG, { uH0: { value: null }, uTime: { value: 0 }, uL: { value: 1 }, uN: { value: N } });
    this.fftMat = raw(FFT_FRAG, { uIn0: { value: null }, uIn1: { value: null }, uNs: { value: 1 }, uHorizontal: { value: 1 }, uN: { value: N } });
    this.asmMat = raw(ASSEMBLE_FRAG, {
      uIn0: { value: null }, uIn1: { value: null }, uPrev: { value: null },
      uChop: { value: sea.choppiness }, uFoamDecay: { value: 0.98 }, uFoamBias: { value: 0.8 },
    });
  }

  /** Displacement (Dx, h, Dz, foam) texture of cascade c. */
  disp(c: number): Texture {
    const k = this.cascades[c];
    return k.out[k.current].textures[0];
  }

  deriv(c: number): Texture {
    const k = this.cascades[c];
    return k.out[k.current].textures[1];
  }

  update(renderer: WebGLRenderer, time: number, dt: number) {
    const stages = Math.log2(this.N);
    this.asmMat.uniforms.uFoamDecay.value = Math.exp(-dt / 2.2);
    for (const c of this.cascades) {
      const su = this.specMat.uniforms;
      su.uH0.value = c.h0;
      su.uTime.value = time;
      su.uL.value = c.L;
      this.pass.render(renderer, this.specMat, c.spec);
      let src = c.spec;
      let dst = c.ping;
      const fu = this.fftMat.uniforms;
      for (let dir = 1; dir >= 0; dir--) {
        fu.uHorizontal.value = dir;
        for (let s = 0; s < stages; s++) {
          fu.uNs.value = 1 << s;
          fu.uIn0.value = src.textures[0];
          fu.uIn1.value = src.textures[1];
          this.pass.render(renderer, this.fftMat, dst);
          src = dst;
          dst = dst === c.ping ? c.pong : c.ping;
        }
      }
      const prev = c.out[c.current];
      c.current = 1 - c.current;
      const au = this.asmMat.uniforms;
      au.uIn0.value = src.textures[0];
      au.uIn1.value = src.textures[1];
      au.uPrev.value = prev.textures[0];
      this.pass.render(renderer, this.asmMat, c.out[c.current]);
    }
  }

  /**
   * Height of the long waves at (x, z), summed directly from the strongest
   * modes, with the choppy horizontal shift undone by fixed-point iteration.
   */
  heightAt(x: number, z: number, t: number): number {
    let px = x, pz = z;
    const chop = this.choppiness;
    for (let it = 0; it < 3; it++) {
      let dx = 0, dz = 0;
      for (const m of this.modes) {
        const { im } = this.modeValue(m, px, pz, t);
        const k = Math.hypot(m.kx, m.kz);
        // D = i k/|k| h  →  real part of i·(re + i im) = -im
        dx += -2 * im * (m.kx / k);
        dz += -2 * im * (m.kz / k);
      }
      px = x - dx * chop;
      pz = z - dz * chop;
    }
    let h = 0;
    for (const m of this.modes) h += 2 * this.modeValue(m, px, pz, t).re;
    return h;
  }

  private modeValue(m: Mode, x: number, z: number, t: number) {
    const ph = m.w * t;
    const c = Math.cos(ph), s = Math.sin(ph);
    // h(k,t) = h0 e^{-iωt} + conj(h0(-k)) e^{iωt}
    const hr = m.ar * c + m.ai * s + m.br * c - m.bi * s;
    const hi = m.ai * c - m.ar * s + m.bi * c + m.br * s;
    const a = m.kx * x + m.kz * z;
    const ca = Math.cos(a), sa = Math.sin(a);
    return { re: hr * ca - hi * sa, im: hr * sa + hi * ca };
  }

  dispose() {
    for (const c of this.cascades) {
      c.h0.dispose();
      [c.spec, c.ping, c.pong, ...c.out].forEach((r) => r.dispose());
    }
    this.specMat.dispose();
    this.fftMat.dispose();
    this.asmMat.dispose();
    this.pass.dispose();
  }
}
