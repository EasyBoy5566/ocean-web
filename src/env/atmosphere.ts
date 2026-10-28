// Single-scattering atmosphere (Rayleigh + Mie + ozone absorption) shared by the
// CPU (light colours, exposure) and the GPU (sky LUT). The GLSL version is
// generated from the same constants in gfx/glsl.ts so both sides agree.
// This file has no imports so it can be exercised directly with Node.

export const R_PLANET = 6371e3;
export const R_ATMOS = 6471e3;
export const B_RAY: readonly [number, number, number] = [5.802e-6, 13.558e-6, 33.1e-6];
export const B_MIE = 8e-6;
export const B_MIE_EXT = B_MIE * 1.11;
export const B_OZONE: readonly [number, number, number] = [0.65e-6, 1.881e-6, 0.085e-6];
export const H_RAY = 8000;
export const H_MIE = 1200;
export const G_MIE = 0.78;

/** Irradiance of the sun in scene units. */
export const SUN_I = 20;
/** Cheap stand-in for multiple scattering: brightens the single-scattered sky. */
export const MS_BOOST = 1.6;
/**
 * Extinction applied to light on its way from the scattering point to the eye.
 * Below 1 it stands in for multiple scattering, which keeps the horizon blue-white
 * instead of the yellow that pure single scattering produces.
 */
export const VIEW_EXTINCTION = 0.5;
/** Moonlight relative to sunlight. Exaggerated (real ≈ 2.5e-6) so moonlit nights read. */
export const MOON_SCALE = 2.2e-4;
/** Airglow + starlight floor so moonless nights are not pure black. */
export const NIGHT_BASE: readonly [number, number, number] = [0.6e-6, 1.1e-6, 2.4e-6];

export type Vec3 = { x: number; y: number; z: number };
export type RGB = [number, number, number];

const PRIMARY_STEPS = 16;
const LIGHT_STEPS = 6;

function raySphere(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, r: number): [number, number] | null {
  const b = ox * dx + oy * dy + oz * dz;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const d = b * b - c;
  if (d < 0) return null;
  const s = Math.sqrt(d);
  return [-b - s, -b + s];
}

function ozone(h: number): number {
  return Math.max(0, 1 - Math.abs(h - 25000) / 15000);
}

/** Optical depths (ray, mie, ozone) from a point at `height` along `dir` to space, or null if the ground blocks it. */
function opticalDepthToSpace(height: number, dir: Vec3, steps: number): RGB | null {
  const oy = R_PLANET + height;
  const ground = raySphere(0, oy, 0, dir.x, dir.y, dir.z, R_PLANET);
  if (ground && ground[0] > 0) return null;
  const atm = raySphere(0, oy, 0, dir.x, dir.y, dir.z, R_ATMOS);
  if (!atm) return [0, 0, 0];
  const len = atm[1];
  const ds = len / steps;
  let r = 0, m = 0, o = 0;
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * ds;
    const px = dir.x * t, py = oy + dir.y * t, pz = dir.z * t;
    const h = Math.sqrt(px * px + py * py + pz * pz) - R_PLANET;
    r += Math.exp(-h / H_RAY) * ds;
    m += Math.exp(-h / H_MIE) * ds;
    o += ozone(h) * ds;
  }
  return [r, m, o];
}

/** Fraction of light (per channel) surviving from space to a point at `height` metres. */
export function transmittance(height: number, dir: Vec3, out: RGB = [0, 0, 0]): RGB {
  const od = opticalDepthToSpace(height, dir, 12);
  if (!od) {
    out[0] = out[1] = out[2] = 0;
    return out;
  }
  for (let c = 0; c < 3; c++) {
    out[c] = Math.exp(-(B_RAY[c] * od[0] + B_MIE_EXT * od[1] + B_OZONE[c] * od[2]));
  }
  return out;
}

/** Single-scattered sky radiance seen from `height` along `view`, lit from `light`. */
export function skyRadiance(height: number, view: Vec3, light: Vec3, intensity: number, out: RGB = [0, 0, 0]): RGB {
  out[0] = out[1] = out[2] = 0;
  const oy = R_PLANET + height;
  const atm = raySphere(0, oy, 0, view.x, view.y, view.z, R_ATMOS);
  if (!atm) return out;
  let tEnd = atm[1];
  const ground = raySphere(0, oy, 0, view.x, view.y, view.z, R_PLANET);
  if (ground && ground[0] > 0) tEnd = Math.min(tEnd, ground[0]);
  const ds = tEnd / PRIMARY_STEPS;
  const mu = view.x * light.x + view.y * light.y + view.z * light.z;
  const pR = (3 / (16 * Math.PI)) * (1 + mu * mu);
  const g = G_MIE;
  const pM = ((3 / (8 * Math.PI)) * ((1 - g * g) * (1 + mu * mu))) / ((2 + g * g) * Math.pow(1 + g * g - 2 * g * mu, 1.5));
  let odR = 0, odM = 0, odO = 0;
  let sR0 = 0, sR1 = 0, sR2 = 0, sM0 = 0, sM1 = 0, sM2 = 0;
  for (let i = 0; i < PRIMARY_STEPS; i++) {
    const t = (i + 0.5) * ds;
    const px = view.x * t, py = oy + view.y * t, pz = view.z * t;
    const len = Math.sqrt(px * px + py * py + pz * pz);
    const h = len - R_PLANET;
    const dR = Math.exp(-h / H_RAY) * ds;
    const dM = Math.exp(-h / H_MIE) * ds;
    odR += dR;
    odM += dM;
    odO += ozone(h) * ds;
    const sh = raySphere(px, py, pz, light.x, light.y, light.z, R_PLANET);
    if (sh && sh[0] > 0) continue;
    const lExit = raySphere(px, py, pz, light.x, light.y, light.z, R_ATMOS);
    if (!lExit) continue;
    const lds = lExit[1] / LIGHT_STEPS;
    let lR = 0, lM = 0, lO = 0;
    for (let j = 0; j < LIGHT_STEPS; j++) {
      const lt = (j + 0.5) * lds;
      const qx = px + light.x * lt, qy = py + light.y * lt, qz = pz + light.z * lt;
      const lh = Math.sqrt(qx * qx + qy * qy + qz * qz) - R_PLANET;
      const r = Math.exp(-lh / H_RAY) * lds;
      lR += r;
      lM += Math.exp(-lh / H_MIE) * lds;
      lO += ozone(lh) * lds;
    }
    const tr = odR * VIEW_EXTINCTION + lR, tm = odM * VIEW_EXTINCTION + lM, to = odO * VIEW_EXTINCTION + lO;
    const a0 = Math.exp(-(B_RAY[0] * tr + B_MIE_EXT * tm + B_OZONE[0] * to));
    const a1 = Math.exp(-(B_RAY[1] * tr + B_MIE_EXT * tm + B_OZONE[1] * to));
    const a2 = Math.exp(-(B_RAY[2] * tr + B_MIE_EXT * tm + B_OZONE[2] * to));
    sR0 += dR * a0; sR1 += dR * a1; sR2 += dR * a2;
    sM0 += dM * a0; sM1 += dM * a1; sM2 += dM * a2;
  }
  out[0] = intensity * (pR * B_RAY[0] * sR0 + pM * B_MIE * sM0);
  out[1] = intensity * (pR * B_RAY[1] * sR1 + pM * B_MIE * sM1);
  out[2] = intensity * (pR * B_RAY[2] * sR2 + pM * B_MIE * sM2);
  return out;
}

/** Multiple scattering matters relatively more in twilight, when single scattering fades fast. */
export function msBoost(sunY: number): number {
  const t = Math.min(1, Math.max(0, (0.05 - sunY) / 0.15));
  return MS_BOOST * (1 + 1.6 * t * t * (3 - 2 * t));
}

export function luminance(c: RGB): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
