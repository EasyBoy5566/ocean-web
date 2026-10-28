import {
  B_MIE, B_MIE_EXT, B_OZONE, B_RAY, G_MIE, H_MIE, H_RAY, MS_BOOST, R_ATMOS, R_PLANET, VIEW_EXTINCTION,
} from '../env/atmosphere';

const f = (n: number) => n.toExponential(6);
const v3 = (a: readonly number[]) => `vec3(${a.map(f).join(', ')})`;

/** Atmosphere scattering, generated from the same constants as the CPU version. */
export const ATMOSPHERE = /* glsl */ `
#ifndef PI
#define PI 3.141592653589793
#endif
const float R_PLANET = ${f(R_PLANET)};
const float R_ATMOS = ${f(R_ATMOS)};
const vec3 B_RAY = ${v3(B_RAY)};
const float B_MIE = ${f(B_MIE)};
const float B_MIE_EXT = ${f(B_MIE_EXT)};
const vec3 B_OZONE = ${v3(B_OZONE)};
const float H_RAY = ${f(H_RAY)};
const float H_MIE = ${f(H_MIE)};
const float G_MIE = ${f(G_MIE)};
const float MS_BOOST = ${f(MS_BOOST)};
const float VIEW_EXT = ${f(VIEW_EXTINCTION)};

vec2 raySphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float d = b * b - c;
  // A miss reports both hits behind the origin, so callers can test .x > 0.0
  if (d < 0.0) return vec2(-1.0, -1.0);
  d = sqrt(d);
  return vec2(-b - d, -b + d);
}

float ozoneDensity(float h) { return max(0.0, 1.0 - abs(h - 25000.0) / 15000.0); }

vec3 atmosphere(vec3 ro, vec3 rd, vec3 L, float intensity) {
  if (intensity <= 0.0) return vec3(0.0);
  vec2 atm = raySphere(ro, rd, R_ATMOS);
  float tEnd = atm.y;
  vec2 gnd = raySphere(ro, rd, R_PLANET);
  if (gnd.x > 0.0) tEnd = min(tEnd, gnd.x);
  const int STEPS = 16;
  const int LSTEPS = 6;
  float ds = tEnd / float(STEPS);
  float mu = dot(rd, L);
  float pR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  float g = G_MIE;
  float pM = 3.0 / (8.0 * PI) * ((1.0 - g * g) * (1.0 + mu * mu)) / ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
  vec3 od = vec3(0.0);
  vec3 sumR = vec3(0.0);
  vec3 sumM = vec3(0.0);
  for (int i = 0; i < STEPS; i++) {
    vec3 p = ro + rd * ((float(i) + 0.5) * ds);
    float h = length(p) - R_PLANET;
    vec3 d = vec3(exp(-h / H_RAY), exp(-h / H_MIE), ozoneDensity(h)) * ds;
    od += d;
    if (raySphere(p, L, R_PLANET).x > 0.0) continue;
    float lds = raySphere(p, L, R_ATMOS).y / float(LSTEPS);
    vec3 odl = vec3(0.0);
    for (int j = 0; j < LSTEPS; j++) {
      vec3 q = p + L * ((float(j) + 0.5) * lds);
      float lh = length(q) - R_PLANET;
      odl += vec3(exp(-lh / H_RAY), exp(-lh / H_MIE), ozoneDensity(lh)) * lds;
    }
    vec3 t = od * VIEW_EXT + odl;
    vec3 att = exp(-(B_RAY * t.x + B_MIE_EXT * t.y + B_OZONE * t.z));
    sumR += d.x * att;
    sumM += d.y * att;
  }
  return intensity * (pR * B_RAY * sumR + pM * B_MIE * sumM);
}
`;

/**
 * Uniforms shared by every material (see gfx/globals.ts). Declared once here so
 * shaders stay in sync with the JS side.
 */
export const GLOBALS = /* glsl */ `
#ifndef PI
#define PI 3.141592653589793
#endif
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uSunColor;
uniform vec3 uMoonColor;
uniform vec3 uSkyAmbient;
uniform vec3 uGroundAmbient;
uniform sampler2D uSkyLUT;
uniform sampler2D uNoiseTex;
uniform float uExposure;
uniform float uFogDensity;
uniform float uMist;
uniform float uMistHeight;
uniform float uReflectionPass;
uniform float uWaterLevel;
uniform vec3 uWaterAbsorb;
uniform vec3 uWaterScatter;
uniform float uNight;

vec2 skyUV(vec3 d) {
  float alt = asin(clamp(d.y, 0.0, 1.0));
  return vec2(atan(d.x, -d.z) / (2.0 * PI) + 0.5, sqrt(alt / (0.5 * PI)));
}

vec3 skyColor(vec3 d) {
  return texture2D(uSkyLUT, skyUV(d)).rgb;
}

/** Light arriving just under the water surface (sky + sun + moon). */
vec3 waterLightIn() {
  return uSkyAmbient + uSunColor * max(uSunDir.y, 0.0) + uMoonColor * max(uMoonDir.y, 0.0);
}

/** Haze colour for a view direction: the sky just above the horizon. */
vec3 hazeColor(vec3 dir) {
  vec3 h = normalize(vec3(dir.x, max(dir.y, 0.0) * 0.35 + 0.085, dir.z));
  return skyColor(h);
}

float fogAmount(vec3 worldPos, float dist) {
  float f = 1.0 - exp(-dist * uFogDensity);
  float mistH = exp(-max(worldPos.y - uWaterLevel, 0.0) / uMistHeight);
  float clump = texture2D(uNoiseTex, worldPos.xz * 0.0021 + vec2(uTime * 0.0011, uTime * 0.0004)).a;
  float m = uMist * mistH * (1.0 - exp(-dist * 0.0035)) * smoothstep(0.25, 0.75, clump) * 0.75;
  return clamp(f + m * (1.0 - f), 0.0, 1.0);
}

vec3 applyFog(vec3 col, vec3 worldPos) {
  vec3 v = worldPos - cameraPosition;
  float dist = length(v);
  vec3 dir = v / dist;
  // Under water only the part of the ray that travels through air gathers haze.
  if (worldPos.y < uWaterLevel && cameraPosition.y > uWaterLevel) {
    float k = (cameraPosition.y - uWaterLevel) / (cameraPosition.y - worldPos.y);
    dist *= k;
    worldPos = cameraPosition + v * k;
  }
  return mix(col, hazeColor(dir), fogAmount(worldPos, dist));
}

/** Tint for anything below the water surface: absorption along light + view paths, plus in-scatter. */
vec3 applyUnderwater(vec3 col, vec3 worldPos) {
  float depth = uWaterLevel - worldPos.y;
  if (depth <= 0.0 || uReflectionPass > 0.5) return col;
  vec3 V = normalize(cameraPosition - worldPos);
  float viewPath = depth / max(V.y, 0.12);
  vec3 tView = exp(-uWaterAbsorb * viewPath);
  vec3 tLight = exp(-uWaterAbsorb * depth);
  vec3 body = uWaterScatter * waterLightIn();
  return col * tLight * tView + body * (1.0 - tView);
}

float caustics(vec2 xz, float depth) {
  vec2 p = xz * 0.55;
  float a = texture2D(uNoiseTex, p * 0.37 + vec2(uTime * 0.021, uTime * 0.013)).g;
  float b = texture2D(uNoiseTex, p * 0.41 - vec2(uTime * 0.017, -uTime * 0.019)).g;
  float c = 1.0 - abs(a - b) * 4.0;
  return pow(clamp(c, 0.0, 1.0), 6.0) * exp(-depth * 0.35);
}

vec3 hemiAmbient(vec3 n) {
  // At night eyes adapt more than a camera would: lift surfaces a little so the land still reads.
  return mix(uGroundAmbient, uSkyAmbient, n.y * 0.5 + 0.5) * (1.0 + 4.0 * uNight);
}
`;

/**
 * Vertex-stage helper: where an underwater point appears to the eye. Refraction
 * at the surface makes water look shallower than it is (about 1/1.33 looking
 * straight down, roughly half at the oblique angles of this view). Only the
 * drawn position moves; shading still uses the true position.
 */
export const APPARENT = /* glsl */ `
uniform float uWaterLevel;
uniform float uReflectionPass;
vec3 apparentPosition(vec3 wp) {
  if (wp.y >= uWaterLevel || uReflectionPass > 0.5 || cameraPosition.y <= uWaterLevel) return wp;
  float depth = uWaterLevel - wp.y;
  vec3 ray = wp - cameraPosition;
  float sinA = length(ray.xz) / length(ray);
  float k = sqrt(max(1.0 - sinA * sinA, 0.0)) / sqrt(max(1.769 - sinA * sinA, 1e-3));
  return vec3(wp.x, uWaterLevel - depth * k, wp.z);
}
`;

export const OUTPUT = /* glsl */ `
#include <tonemapping_fragment>
#include <colorspace_fragment>
`;
