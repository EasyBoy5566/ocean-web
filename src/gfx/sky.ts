import {
  BackSide, Color, HalfFloatType, LinearFilter, Matrix3, Mesh, RepeatWrapping, ClampToEdgeWrapping,
  ShaderMaterial, SphereGeometry, Vector3, WebGLRenderTarget, type WebGLRenderer,
} from 'three';
import { NIGHT_BASE, SUN_I } from '../env/atmosphere';

import { FullscreenPass, FULLSCREEN_VERT } from './fullscreen';
import { ATMOSPHERE, GLOBALS, OUTPUT } from './glsl';
import { globals } from './globals';

/**
 * Sky-view lookup table: the scattered sky radiance for the whole upper
 * hemisphere rendered into a small texture. Everything that needs the sky
 * colour (dome, fog, water) samples it instead of re-integrating.
 */
export class SkyLUT {
  readonly target: WebGLRenderTarget;
  private pass = new FullscreenPass();
  private material: ShaderMaterial;

  constructor(width = 192, height = 96) {
    this.target = new WebGLRenderTarget(width, height, {
      type: HalfFloatType,
      magFilter: LinearFilter,
      minFilter: LinearFilter,
      depthBuffer: false,
      generateMipmaps: false,
    });
    this.target.texture.wrapS = RepeatWrapping;
    this.target.texture.wrapT = ClampToEdgeWrapping;
    this.material = new ShaderMaterial({
      uniforms: {
        uSunDir: globals.uSunDir,
        uMoonDir: globals.uMoonDir,
        uMoonI: { value: 0 },
        uSunI: { value: SUN_I },
        uNightBase: { value: new Vector3(...NIGHT_BASE) },
        uBoost: { value: 1.6 },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        ${ATMOSPHERE}
        uniform vec3 uSunDir;
        uniform vec3 uMoonDir;
        uniform float uMoonI;
        uniform float uSunI;
        uniform vec3 uNightBase;
        uniform float uBoost;
        varying vec2 vUv;
        void main() {
          float alt = vUv.y * vUv.y * 0.5 * PI;
          float az = (vUv.x - 0.5) * 2.0 * PI;
          vec3 d = vec3(cos(alt) * sin(az), sin(alt), -cos(alt) * cos(az));
          vec3 ro = vec3(0.0, R_PLANET + 20.0, 0.0);
          vec3 c = atmosphere(ro, d, uSunDir, uSunI) + atmosphere(ro, d, uMoonDir, uMoonI);
          gl_FragColor = vec4(c * uBoost + uNightBase, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    globals.uSkyLUT.value = this.target.texture;
  }

  update(renderer: WebGLRenderer, moonIntensity: number, boost: number) {
    this.material.uniforms.uMoonI.value = moonIntensity;
    this.material.uniforms.uBoost.value = boost;
    this.pass.render(renderer, this.material, this.target);
  }

  dispose() {
    this.target.dispose();
    this.material.dispose();
    this.pass.dispose();
  }
}

export interface SkyDomeUniforms {
  uStarMat: { value: Matrix3 };
  uStarVis: { value: number };
  uMoonDiscI: { value: number };
  uMoonTint: { value: Color };
  uSunDisc: { value: Color };
  uCloudCover: { value: number };
  uCloudSun: { value: Color };
  uCloudMoon: { value: Color };
  uCloudOctaves: { value: number };
  uWind: { value: Vector3 };
}

/** Shared cloud-layer GLSL, also used to shade cloud reflections. */
export const CLOUDS = /* glsl */ `
uniform float uCloudCover;
uniform vec3 uCloudSun;
uniform vec3 uCloudMoon;
uniform int uCloudOctaves;
uniform vec3 uWind;

float cloudFbm(vec2 p) {
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= uCloudOctaves) break;
    s += a * texture2D(uNoiseTex, p).r;
    n += a;
    p = p * 2.03 + vec2(0.17, 0.31);
    a *= 0.5;
  }
  return s / n;
}

float hg(float mu, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * mu, 1.5));
}

// rgb = cloud radiance, a = coverage
vec4 cloudLayer(vec3 dir, vec3 skyBehind) {
  if (dir.y <= 0.0 || uCloudCover <= 0.0) return vec4(0.0);
  float t = 2200.0 / (dir.y + 0.035);
  vec2 p = dir.xz * t;
  vec2 uv = p / 14000.0 + uWind.xy * uTime;
  float n = cloudFbm(uv);
  float lo = 1.0 - uCloudCover;
  float dens = smoothstep(lo - 0.02, lo + 0.22, n);
  if (dens <= 0.001) return vec4(0.0);
  vec2 toSun = normalize(uSunDir.xz + vec2(1e-4)) * 0.012;
  float n2 = cloudFbm(uv + toSun);
  float shadow = exp(-max(n2 - lo, 0.0) * 7.0);
  // A low sun lights the cloud base from below instead of through the cloud.
  shadow = mix(shadow, 1.0, smoothstep(0.22, 0.0, uSunDir.y) * 0.65);
  vec2 toMoon = normalize(uMoonDir.xz + vec2(1e-4)) * 0.012;
  float shadowM = exp(-max(cloudFbm(uv + toMoon) - lo, 0.0) * 7.0);
  float mu = dot(dir, uSunDir);
  float phase = 1.2 + 9.0 * hg(mu, 0.55) + 2.0 * hg(mu, -0.2);
  float muM = dot(dir, uMoonDir);
  float phaseM = 1.2 + 9.0 * hg(muM, 0.55);
  float thick = smoothstep(lo, lo + 0.5, n);
  vec3 amb = uSkyAmbient * (1.25 - 0.55 * thick);
  vec3 col = uCloudSun * shadow * phase * (1.0 - 0.45 * thick) + uCloudMoon * shadowM * phaseM + amb;
  // aerial perspective towards the horizon
  float far = 1.0 - exp(-t / 45000.0);
  col = mix(col, skyBehind, far * 0.85);
  return vec4(col, dens * (1.0 - far * 0.4));
}
`;

/** Sky dome: atmosphere LUT + sun + moon (with real phase) + stars + clouds. */
export class SkyDome {
  readonly mesh: Mesh;
  readonly uniforms: SkyDomeUniforms;

  constructor() {
    this.uniforms = {
      uStarMat: { value: new Matrix3() },
      uStarVis: { value: 0 },
      uMoonDiscI: { value: 0 },
      uMoonTint: { value: new Color(1, 1, 1) },
      uSunDisc: { value: new Color(0, 0, 0) },
      uCloudCover: { value: 0.35 },
      uCloudSun: { value: new Color(0, 0, 0) },
      uCloudMoon: { value: new Color(0, 0, 0) },
      uCloudOctaves: { value: 4 },
      uWind: { value: new Vector3(0.0009, 0.0004, 0) },
    };
    const material = new ShaderMaterial({
      uniforms: { ...globals, ...this.uniforms },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
          gl_Position = vec4(p.xy, p.w * 0.99999, p.w);
        }
      `,
      fragmentShader: /* glsl */ `
        ${GLOBALS}
        ${CLOUDS}
        uniform mat3 uStarMat;
        uniform float uStarVis;
        uniform float uMoonDiscI;
        uniform vec3 uMoonTint;
        uniform vec3 uSunDisc;
        varying vec3 vDir;

        float hash13(vec3 p) {
          p = fract(p * 0.1031);
          p += dot(p, p.zyx + 31.32);
          return fract((p.x + p.y) * p.z);
        }

        vec3 stars(vec3 dir) {
          vec3 eq = dir * uStarMat;
          vec3 q = eq * 150.0;
          vec3 cell = floor(q);
          vec3 f = q - cell;
          float h = hash13(cell);
          vec3 col = vec3(0.0);
          if (h > 0.955) {
            vec3 pos = vec3(hash13(cell + 11.3), hash13(cell + 27.1), hash13(cell + 41.7)) * 0.7 + 0.15;
            float px = max(length(fwidth(q)), 1e-4);
            float d = length(f - pos);
            float mag = pow((h - 0.955) / 0.045, 6.0);
            float core = exp(-d * d / (px * px * 0.55));
            float tw = 0.75 + 0.25 * sin(uTime * (2.0 + 6.0 * hash13(cell + 3.1)) + h * 80.0);
            vec3 tint = mix(vec3(1.0, 0.78, 0.6), vec3(0.72, 0.82, 1.0), hash13(cell + 5.9));
            col = tint * core * (0.08 + 2.6 * mag) * tw;
          }
          // Milky Way: a soft band around the galactic equator.
          const vec3 GAL_POLE = vec3(-0.8676, -0.1981, 0.4560);
          const vec3 GAL_CENTER = vec3(-0.0548, -0.8734, -0.4838);
          float b = dot(eq, GAL_POLE);
          float band = exp(-b * b / 0.018);
          float core = pow(max(dot(eq, GAL_CENTER), 0.0), 3.0);
          float cl = texture2D(uNoiseTex, eq.xy * 1.7 + eq.z * 0.9).r;
          float dust = smoothstep(0.42, 0.7, texture2D(uNoiseTex, eq.yz * 2.3).a);
          col += vec3(0.75, 0.8, 1.0) * band * (0.025 + 0.05 * core) * (0.4 + cl) * (1.0 - 0.6 * dust * band);
          return col;
        }

        void basis(vec3 n, out vec3 t, out vec3 b) {
          vec3 up = abs(n.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
          t = normalize(cross(up, n));
          b = cross(n, t);
        }

        vec3 moonDisc(vec3 d) {
          const float R = 0.0155;
          float c = dot(d, uMoonDir);
          if (c < cos(R * 1.3)) return vec3(0.0);
          vec3 tx, ty;
          basis(uMoonDir, tx, ty);
          vec2 pd = vec2(dot(d, tx), dot(d, ty)) / R;
          float r2 = dot(pd, pd);
          float edge = 1.0 - smoothstep(0.94, 1.0, r2);
          if (edge <= 0.0) return vec3(0.0);
          vec3 n = normalize(tx * pd.x + ty * pd.y - uMoonDir * sqrt(max(1.0 - r2, 0.0)));
          float lit = smoothstep(-0.03, 0.12, dot(n, uSunDir));
          float maria = texture2D(uNoiseTex, pd * 0.23 + 0.31).a;
          float albedo = mix(1.0, 0.62, smoothstep(0.45, 0.62, maria));
          albedo *= 0.9 + 0.1 * texture2D(uNoiseTex, pd * 0.9).b;
          float earthshine = 0.012;
          return uMoonTint * uMoonDiscI * (lit * albedo + earthshine) * edge;
        }

        void main() {
          vec3 d = normalize(vDir);
          vec3 dd = vec3(d.x, max(d.y, 0.0), d.z);
          vec3 col = skyColor(dd);
          if (d.y < 0.0) col *= mix(1.0, 0.55, clamp(-d.y * 6.0, 0.0, 1.0));
          float horizonExt = smoothstep(-0.02, 0.25, d.y);
          if (uStarVis > 0.001 && d.y > -0.02) {
            col += stars(d) * uStarVis / uExposure * horizonExt;
          }
          col += moonDisc(d);
          if (uReflectionPass < 0.5) {
            float mu = dot(d, uSunDir);
            float r = 0.0085;
            float disc = smoothstep(cos(r * 1.08), cos(r * 0.92), mu);
            float limb = 0.6 + 0.4 * sqrt(max(1.0 - pow(acos(min(mu, 1.0)) / r, 2.0), 0.0));
            col += uSunDisc * disc * limb;
            col += uSunDisc * 0.0016 * pow(max(mu, 0.0), 900.0);
          }
          vec4 cl = cloudLayer(d, col);
          col = mix(col, cl.rgb, cl.a);
          // In the reflection pass alpha 0 marks 'sky' so open water can use its own sky reflection.
          gl_FragColor = vec4(col, uReflectionPass > 0.5 ? 0.0 : 1.0);
          ${OUTPUT}
        }
      `,
      side: BackSide,
      depthWrite: false,
      depthTest: false,
    });
    this.mesh = new Mesh(new SphereGeometry(1, 48, 24), material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as ShaderMaterial).dispose();
  }
}

export { SUN_I };
