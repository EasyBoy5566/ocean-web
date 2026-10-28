import { Matrix4, Mesh, ShaderMaterial, Vector2, Vector3, Vector4, type Texture } from 'three';
import { LAYER_SURFACE } from './composite';
import { GLOBALS, OUTPUT } from './glsl';
import { globals } from './globals';
import { createCameraGrid } from './grid';
import { WATER_SLOPE_SCALE } from './textures';

export type WaterMode = 'lake' | 'ocean' | 'river';

export interface Wave {
  /** Direction of travel in world XZ (normalised internally). */
  dir: [number, number];
  amplitude: number;
  wavelength: number;
}

export interface WaterOptions {
  mode: WaterMode;
  normalTex: Texture;
  reflection: Texture;
  reflectionMatrix: Matrix4;
  scene: { color: Texture; depth: Texture };
  sim: { tex: Texture | null; map: Vector4; size: Vector2 };
  data: { tex: Texture; bounds: Vector4; depthMax: number; flowMax: number };
  detail: number;
  detailScale: [number, number];
  detailSpeed: number;
  windDir: [number, number];
  roughness: number;
  roughnessFar: number;
  reflectionDistort: number;
  reflectionStrength: number;
  shoreFoam: number;
  sss: [number, number, number];
  waves?: Wave[];
  steepness?: number;
  grid: { cols: number; rows: number; near: number; far: number; halfWidth: number };
}

export const MAX_WAVES = 8;

export const WATER_VERT = /* glsl */ `
${GLOBALS}
uniform mat4 uReflMatrix;
#ifdef OCEAN
uniform vec4 uWaves[${MAX_WAVES}];
uniform float uSteep;
#endif
varying vec3 vWorld;
varying vec4 vRefl;
varying vec3 vNrm;
varying float vCrest;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vNrm = vec3(0.0, 1.0, 0.0);
  vCrest = 0.0;
#ifdef OCEAN
  float dist = length(wp.xz - cameraPosition.xz);
  vec3 disp = vec3(0.0);
  float sx = 0.0, sz = 0.0, sy = 0.0;
  for (int i = 0; i < ${MAX_WAVES}; i++) {
    vec4 w = uWaves[i];
    if (w.z <= 0.0) continue;
    float k = 2.0 * PI / w.w;
    float fade = 1.0 - smoothstep(w.w * 22.0, w.w * 70.0, dist);
    float a = w.z * fade;
    float omega = sqrt(9.81 * k);
    float ph = k * dot(w.xy, wp.xz) - omega * uTime + float(i) * 1.93;
    float s = sin(ph);
    float c = cos(ph);
    float Q = uSteep / (k * w.z * float(${MAX_WAVES}));
    disp.x += Q * a * w.x * c;
    disp.z += Q * a * w.y * c;
    disp.y += a * s;
    sx += w.x * k * a * c;
    sz += w.y * k * a * c;
    sy += Q * k * a * s;
  }
  wp.xyz += disp;
  vNrm = normalize(vec3(-sx, 1.0 - sy, -sz));
  vCrest = sy;
#endif
  vWorld = wp.xyz;
  vRefl = uReflMatrix * vec4(wp.x, uWaterLevel, wp.z, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const WATER_FRAG = /* glsl */ `
${GLOBALS}
uniform sampler2D uReflTex;
uniform float uReflDistort;
uniform float uReflStrength;
uniform sampler2D uNormalTex;
uniform float uDetail;
uniform vec2 uDetailScale;
uniform float uDetailSpeed;
uniform vec2 uWindDir;
uniform sampler2D uSimTex;
uniform vec4 uSimMap;
uniform vec2 uSimSize;
uniform sampler2D uDataTex;
uniform vec4 uDataBounds;
uniform float uDepthMax;
uniform float uFlowMax;
uniform float uRough;
uniform float uRoughFar;
uniform float uShoreFoam;
uniform vec3 uSSS;
uniform float uSteep;
uniform sampler2D uSceneColor;
uniform sampler2D uSceneDepth;
uniform vec2 uResolution;
uniform float uRefract;
uniform float uRippleGain;
varying vec3 vWorld;
varying vec4 vRefl;
varying vec3 vNrm;
varying float vCrest;

const float SLOPE_SCALE = ${WATER_SLOPE_SCALE.toFixed(4)};

vec4 waterData(vec2 xz) {
  vec2 uv = (xz - uDataBounds.xy) / uDataBounds.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(1.0, 0.5, 0.5, 0.0);
  return texture2D(uDataTex, uv);
}

vec2 tapSlope(vec2 uv) {
  return (texture2D(uNormalTex, uv).rg * 2.0 - 1.0) * SLOPE_SCALE;
}

vec2 detailSlope(vec2 xz, vec2 flow) {
#ifdef RIVER
  float sp = 0.7;
  float p0 = fract(uTime * sp);
  float p1 = fract(uTime * sp + 0.5);
  float w0 = 1.0 - abs(2.0 * p0 - 1.0);
  vec2 off0 = flow * (p0 / sp);
  vec2 off1 = flow * (p1 / sp);
  vec2 a = tapSlope((xz - off0) * uDetailScale.x) + tapSlope((xz - off0) * uDetailScale.y + 0.31) * 0.6;
  vec2 b = tapSlope((xz - off1) * uDetailScale.x + 0.5) + tapSlope((xz - off1) * uDetailScale.y + 0.81) * 0.6;
  vec2 s = mix(b, a, w0);
  // turbulence grows with flow speed
  s *= 0.6 + 0.5 * length(flow);
  s += tapSlope(xz * 0.07 + fract(uWindDir * uTime * 0.01)) * 0.25;
  return s * uDetail;
#else
  vec2 uv1 = xz * uDetailScale.x + fract(uWindDir * uTime * uDetailSpeed);
  mat2 R = mat2(0.8, -0.6, 0.6, 0.8);
  vec2 uv2 = R * xz * uDetailScale.y + fract(R * uWindDir * uTime * uDetailSpeed * 1.63);
  return (tapSlope(uv1) + tapSlope(uv2) * 0.65) * uDetail;
#endif
}

vec2 simSlope(vec2 xz, out float foam) {
  foam = 0.0;
  if (uSimMap.w < 0.5) return vec2(0.0);
  float d = -xz.y;
  if (d < uSimMap.x) return vec2(0.0);
  vec2 uv = vec2(xz.x / (2.0 * uSimMap.z * d) + 0.5, log(d / uSimMap.x) / uSimMap.y);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec2(0.0);
  vec2 texel = 1.0 / uSimSize;
  float s = 2.0 * uSimMap.z * d / uSimSize.x;
  vec4 c = texture2D(uSimTex, uv);
  float hl = texture2D(uSimTex, uv - vec2(texel.x, 0.0)).r;
  float hr = texture2D(uSimTex, uv + vec2(texel.x, 0.0)).r;
  float hd = texture2D(uSimTex, uv - vec2(0.0, texel.y)).r;
  float hu = texture2D(uSimTex, uv + vec2(0.0, texel.y)).r;
  float e = smoothstep(0.0, 0.05, uv.x) * smoothstep(1.0, 0.95, uv.x) * smoothstep(1.0, 0.92, uv.y);
  foam = c.b * e;
  return vec2((hr - hl) / (2.0 * s), -(hu - hd) / (2.0 * s)) * e * uRippleGain;
}

float specGGX(vec3 n, vec3 v, vec3 l, float r) {
  if (l.y < -0.01) return 0.0;
  vec3 h = normalize(l + v);
  float a = r * r;
  float a2 = a * a;
  float nh = max(dot(n, h), 0.0);
  float nl = max(dot(n, l), 0.0);
  float nv = max(dot(n, v), 1e-3);
  float dd = nh * nh * (a2 - 1.0) + 1.0;
  float D = a2 / (PI * dd * dd);
  float k = a * 0.5;
  float G = (nl / (nl * (1.0 - k) + k)) * (nv / (nv * (1.0 - k) + k));
  float F = 0.02 + 0.98 * pow(1.0 - max(dot(h, v), 0.0), 5.0);
  return D * G * F / (4.0 * nv);
}

void main() {
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  vec4 wd = waterData(vWorld.xz);
  float depth = wd.r * uDepthMax;
  vec2 flow = (wd.gb * 2.0 - 1.0) * uFlowMax;

  vec3 gn = normalize(vNrm);
  vec2 slope = -gn.xz / gn.y;
  float near = 1.0 / (1.0 + dist * 0.01);
  slope += detailSlope(vWorld.xz, flow) * mix(0.35, 1.0, near);
  float simFoam;
  slope += simSlope(vWorld.xz, simFoam);
  vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));
  // Keep normals from facing away from the eye (back sides of crests would mirror the horizon as hard lines).
  n = normalize(n + V * max(0.0, 0.25 - dot(n, V)));

  float NdV = max(dot(n, V), 0.0);
  float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);

  vec2 rc = vRefl.xy / vRefl.w + slope * uReflDistort / (1.0 + dist * 0.04);
  vec4 planar = texture2D(uReflTex, clamp(rc, 0.001, 0.999));
  vec3 refl = planar.rgb * uReflStrength;

#ifdef OCEAN
  // Open sea: reflect the sky along the true reflected ray (planar alpha marks real objects).
  // Rays reflected downwards hit the next wave, so they see water rather than horizon.
  // Far away the rough surface averages a band of sky above the horizon.
  vec3 R = reflect(-V, n);
  float farR = smoothstep(60.0, 1400.0, dist);
  vec3 Rs = normalize(vec3(R.x, max(R.y, 0.0) + 0.02 + 0.12 * farR, R.z));
  float up = smoothstep(-0.05, 0.05, R.y);
  vec3 skyR = skyColor(Rs) * up + uWaterScatter * waterLightIn() * 6.0 * (1.0 - up);
  refl = mix(skyR, planar.rgb, planar.a) * uReflStrength;
#endif
  float rough = clamp(uRough + uRoughFar * smoothstep(15.0, 3000.0, dist), 0.02, 0.6);
  vec3 spec = uSunColor * specGGX(n, V, uSunDir, rough) + uMoonColor * specGGX(n, V, uMoonDir, rough * 1.3);

  // fine, speckled foam: two scales of noise so it reads as bubbles, not a blot
  float b1 = texture2D(uNoiseTex, vWorld.xz * 4.1 + fract(uTime * 0.03)).b;
  float b2 = texture2D(uNoiseTex, vWorld.xz * 9.3 - fract(uTime * 0.05)).b;
  float foam = simFoam * smoothstep(0.45, 0.8, b1 * 0.6 + b2 * 0.6 + simFoam * 0.25) * 0.85;
#ifdef OCEAN
  // whitecaps only where a steep crest coincides with a gust patch
  float crest = smoothstep(0.7, 1.0, vCrest / max(uSteep, 1e-3));
  float gust = texture2D(uNoiseTex, vWorld.xz * 0.006 + fract(vec2(uTime * 0.002, uTime * 0.005))).a;
  float breakup = texture2D(uNoiseTex, vWorld.xz * 0.05 + fract(vec2(uTime * 0.004, uTime * 0.011))).b;
  foam += crest * smoothstep(0.55, 0.8, gust) * smoothstep(0.45, 0.8, breakup) * 0.8;
  float shore = 1.0 - smoothstep(0.0, 1.4, depth);
  float bands = texture2D(uNoiseTex, vWorld.xz * 0.05).a;
  float surge = sin(depth * 3.2 - uTime * 1.3 + bands * 7.0) * 0.5 + 0.5;
  float lace = texture2D(uNoiseTex, vWorld.xz * 0.21 + vec2(0.0, uTime * 0.03)).b;
  foam += shore * smoothstep(0.45, 0.85, surge * 0.7 + lace * 0.6) * uShoreFoam;
  foam += (1.0 - smoothstep(0.0, 0.35, depth)) * 0.7 * lace;
#endif
#ifdef RIVER
  float p0 = fract(uTime * 0.5);
  float w0 = 1.0 - abs(2.0 * p0 - 1.0);
  float fa = texture2D(uNoiseTex, (vWorld.xz - flow * p0 * 2.0) * 0.45).b;
  float fb = texture2D(uNoiseTex, (vWorld.xz - flow * fract(p0 + 0.5) * 2.0) * 0.45 + 0.5).b;
  float churn = mix(fb, fa, w0);
  foam += smoothstep(0.25, 0.75, wd.a * (0.55 + 0.9 * churn)) * 0.95;
  foam += (1.0 - smoothstep(0.0, 0.08, depth)) * 0.12 * churn;
#endif
#ifdef LAKE
  foam += (1.0 - smoothstep(0.0, 0.08, depth)) * 0.25 * texture2D(uNoiseTex, vWorld.xz * 0.3).b * uShoreFoam;
#endif
  foam = clamp(foam, 0.0, 1.0);

  // What is seen through the surface: the scene behind, bent by the surface normal.
  // Samples that land on something in front of the water are not refracted.
  vec2 suv = gl_FragCoord.xy / uResolution;
  vec2 ruv = clamp(suv + vec2(n.x, n.z) * uRefract / (1.0 + dist * 0.06), vec2(0.001), vec2(0.999));
  if (texture2D(uSceneDepth, ruv).r < gl_FragCoord.z) ruv = suv;
  vec3 under = texture2D(uSceneColor, ruv).rgb;

  vec3 premul = refl * F + spec;
  float alpha = F;

#ifdef OCEAN
  vec2 hv = normalize(-V.xz + vec2(1e-5));
  vec2 hs = normalize(uSunDir.xz + vec2(1e-5));
  float back = pow(clamp(dot(hv, hs), 0.0, 1.0), 3.0) * (1.0 - clamp(uSunDir.y, 0.0, 1.0));
  float lift = smoothstep(0.05, 0.9, vWorld.y);
  vec3 sss = uSSS * (uSunColor * back * 1.2 + uSkyAmbient * 0.25) * lift;
  premul += sss * (1.0 - F);
#endif

  vec3 foamCol = vec3(0.92) * (uSunColor * clamp(dot(n, uSunDir) * 0.6 + 0.4, 0.0, 1.0) + uSkyAmbient * 1.1 + uMoonColor * 0.5);
  premul = premul * (1.0 - foam) + foamCol * foam;
  alpha = alpha * (1.0 - foam) + foam;

  float fg = fogAmount(vWorld, dist);
  premul = premul * (1.0 - fg) + hazeColor(-V) * fg * alpha;
  gl_FragColor = vec4(under * (1.0 - alpha) + premul, 1.0);
  ${OUTPUT}
}
`;

/** The water surface: a camera-fitted grid with the shared water shader. */
export function createWater(o: WaterOptions) {
  const geo = createCameraGrid({ ...o.grid });
  const waves = Array.from({ length: MAX_WAVES }, (_, i) => {
    const w = o.waves?.[i];
    if (!w) return new Vector4(1, 0, 0, 1);
    const len = Math.hypot(w.dir[0], w.dir[1]) || 1;
    return new Vector4(w.dir[0] / len, w.dir[1] / len, w.amplitude, w.wavelength);
  });
  const material = new ShaderMaterial({
    defines: { [o.mode.toUpperCase()]: '' },
    uniforms: {
      ...globals,
      uReflTex: { value: o.reflection },
      uReflMatrix: { value: o.reflectionMatrix },
      uReflDistort: { value: o.reflectionDistort },
      uReflStrength: { value: o.reflectionStrength },
      uNormalTex: { value: o.normalTex },
      uDetail: { value: o.detail },
      uDetailScale: { value: new Vector2(...o.detailScale) },
      uDetailSpeed: { value: o.detailSpeed },
      uWindDir: { value: new Vector2(...o.windDir).normalize() },
      uSimTex: { value: o.sim.tex },
      uSimMap: { value: o.sim.map },
      uSimSize: { value: o.sim.size },
      uDataTex: { value: o.data.tex },
      uDataBounds: { value: o.data.bounds },
      uDepthMax: { value: o.data.depthMax },
      uFlowMax: { value: o.data.flowMax },
      uRough: { value: o.roughness },
      uRoughFar: { value: o.roughnessFar },
      uShoreFoam: { value: o.shoreFoam },
      uSSS: { value: new Vector3(...o.sss) },
      uWaves: { value: waves },
      uSteep: { value: o.steepness ?? 0 },
      uSceneColor: { value: o.scene.color },
      uSceneDepth: { value: o.scene.depth },
      uResolution: { value: new Vector2(1, 1) },
      uRefract: { value: 0.035 },
      uRippleGain: { value: 1.7 },
    },
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
  });
  const mesh = new Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.layers.set(LAYER_SURFACE);
  return { mesh, material };
}

/** CPU twin of the ocean vertex shader, for picking and stone physics. */
export function oceanHeight(waves: Wave[], steep: number, x: number, z: number, t: number): number {
  // Gerstner waves displace horizontally; find the undisplaced point by fixed-point iteration.
  let px = x, pz = z;
  const n = MAX_WAVES;
  for (let it = 0; it < 3; it++) {
    let dx = 0, dz = 0;
    for (let i = 0; i < waves.length; i++) {
      const w = waves[i];
      const len = Math.hypot(w.dir[0], w.dir[1]) || 1;
      const Dx = w.dir[0] / len, Dz = w.dir[1] / len;
      const k = (2 * Math.PI) / w.wavelength;
      const omega = Math.sqrt(9.81 * k);
      const ph = k * (Dx * px + Dz * pz) - omega * t + i * 1.93;
      const Q = steep / (k * w.amplitude * n);
      dx += Q * w.amplitude * Dx * Math.cos(ph);
      dz += Q * w.amplitude * Dz * Math.cos(ph);
    }
    px = x - dx;
    pz = z - dz;
  }
  let y = 0;
  for (let i = 0; i < waves.length; i++) {
    const w = waves[i];
    const len = Math.hypot(w.dir[0], w.dir[1]) || 1;
    const k = (2 * Math.PI) / w.wavelength;
    const omega = Math.sqrt(9.81 * k);
    const ph = k * ((w.dir[0] / len) * px + (w.dir[1] / len) * pz) - omega * t + i * 1.93;
    y += w.amplitude * Math.sin(ph);
  }
  return y;
}
