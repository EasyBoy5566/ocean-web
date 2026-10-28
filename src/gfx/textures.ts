import {
  DataTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, RGBAFormat, UnsignedByteType,
} from 'three';
import { hash2i, mulberry32 } from '../util/math';

function fade(t: number) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Gradient noise that tiles with integer `period` (in lattice cells). Range ≈ [-0.7, 0.7]. */
function periodicPerlin(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const grad = (i: number, j: number, dx: number, dy: number) => {
    const a = hash2i(((i % period) + period) % period, ((j % period) + period) % period, seed) * Math.PI * 2;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  const n00 = grad(xi, yi, xf, yf);
  const n10 = grad(xi + 1, yi, xf - 1, yf);
  const n01 = grad(xi, yi + 1, xf, yf - 1);
  const n11 = grad(xi + 1, yi + 1, xf - 1, yf - 1);
  const u = fade(xf), v = fade(yf);
  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  return a + (b - a) * v;
}

function tileFbm(u: number, v: number, basePeriod: number, octaves: number, seed: number) {
  let sum = 0, amp = 1, norm = 0, p = basePeriod;
  for (let o = 0; o < octaves; o++) {
    sum += amp * periodicPerlin(u * p, v * p, p, seed + o * 101);
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  return sum / norm;
}

function finish(tex: DataTexture) {
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Tileable multi-purpose noise:
 *  R: cloud fbm, G: smooth single-octave noise (caustics, variation),
 *  B: fine fbm detail, A: medium fbm.
 */
export function createNoiseTexture(size = 256): DataTexture {
  const data = new Uint8Array(size * size * 4);
  const to8 = (n: number, gain: number) => Math.max(0, Math.min(255, Math.round((n * gain + 0.5) * 255)));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const i = (y * size + x) * 4;
      data[i] = to8(tileFbm(u, v, 4, 5, 11), 1.05);
      data[i + 1] = to8(periodicPerlin(u * 8, v * 8, 8, 23), 0.75);
      data[i + 2] = to8(tileFbm(u, v, 16, 4, 37), 1.0);
      data[i + 3] = to8(tileFbm(u, v, 8, 3, 53), 1.0);
    }
  }
  return finish(new DataTexture(data, size, size, RGBAFormat, UnsignedByteType));
}

/** Slope range encoded in the water normal texture: slope = (rg * 2 - 1) * WATER_SLOPE_SCALE. */
export const WATER_SLOPE_SCALE = 1.6;

/**
 * Tileable water surface built from a spectrum of directional sine waves with
 * integer wave vectors (so the tile repeats seamlessly). RG = slopes, B = height.
 */
export function createWaterNormalTexture(size = 256): DataTexture {
  const rnd = mulberry32(7);
  type Wave = { kx: number; ky: number; amp: number; phase: number };
  const waves: Wave[] = [];
  const used = new Set<string>();
  while (waves.length < 48) {
    const mag = 2 + Math.pow(rnd(), 1.6) * 34;
    const ang = (rnd() - 0.5) * Math.PI * 1.5;
    const kx = Math.round(Math.cos(ang) * mag);
    const ky = Math.round(Math.sin(ang) * mag);
    const key = `${kx},${ky}`;
    if ((kx === 0 && ky === 0) || used.has(key)) continue;
    used.add(key);
    const k = Math.hypot(kx, ky);
    waves.push({ kx, ky, amp: 1 / Math.pow(k, 1.45), phase: rnd() * Math.PI * 2 });
  }
  const h = new Float32Array(size * size);
  const sx = new Float32Array(size * size);
  const sy = new Float32Array(size * size);
  let maxS = 0, maxH = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      let hh = 0, dx = 0, dy = 0;
      for (const w of waves) {
        const ph = 2 * Math.PI * (w.kx * u + w.ky * v) + w.phase;
        const s = Math.sin(ph), c = Math.cos(ph);
        hh += w.amp * s;
        // d/du with the tile mapped to unit length
        dx += w.amp * 2 * Math.PI * w.kx * c;
        dy += w.amp * 2 * Math.PI * w.ky * c;
      }
      const i = y * size + x;
      h[i] = hh;
      sx[i] = dx;
      sy[i] = dy;
      maxH = Math.max(maxH, Math.abs(hh));
      maxS = Math.max(maxS, Math.abs(dx), Math.abs(dy));
    }
  }
  const data = new Uint8Array(size * size * 4);
  // Normalise slopes into the encoded range; the shader rescales per scene.
  const sNorm = WATER_SLOPE_SCALE / maxS;
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = Math.round(((sx[i] * sNorm) / WATER_SLOPE_SCALE * 0.5 + 0.5) * 255);
    data[i * 4 + 1] = Math.round(((sy[i] * sNorm) / WATER_SLOPE_SCALE * 0.5 + 0.5) * 255);
    data[i * 4 + 2] = Math.round((h[i] / maxH * 0.5 + 0.5) * 255);
    data[i * 4 + 3] = 255;
  }
  return finish(new DataTexture(data, size, size, RGBAFormat, UnsignedByteType));
}
