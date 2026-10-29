import { Color, DoubleSide, ShaderMaterial, Vector3, Vector4 } from 'three';
import type { GroundLayer } from './assets';
import { APPARENT, GLOBALS, OUTPUT } from './glsl';
import { globals } from './globals';

export interface TerrainColors {
  grass: Color;
  forest: Color;
  rock: Color;
  sand: Color;
  bed: Color;
}

/** Photoscanned ground materials for the near field (see gfx/assets.ts). */
export interface TerrainLayers {
  ground: GroundLayer;
  rock: GroundLayer;
  shore: GroundLayer;
  bed: GroundLayer;
}

const TERRAIN_LAYERS = /* glsl */ `
uniform sampler2D uGroundA;
uniform sampler2D uGroundN;
uniform sampler2D uRockA;
uniform sampler2D uRockN;
uniform sampler2D uShoreA;
uniform sampler2D uShoreN;
uniform sampler2D uBedA;
uniform sampler2D uBedN;
uniform vec4 uTiles;
uniform vec3 uGroundTint;

// Ground lying flat: XZ projection, plus a rotated, larger second sample that hides tiling.
void planar(sampler2D A, sampler2D N, vec2 xz, float tile, float w, inout vec3 alb, inout vec3 dn, inout float rough) {
  if (w < 0.003) return;
  vec2 uv = xz / tile;
  vec3 a = texture2D(A, uv).rgb;
  a = mix(a, texture2D(A, mat2(0.8, -0.6, 0.6, 0.8) * uv * 0.37 + 0.31).rgb, 0.35);
  vec3 n = texture2D(N, uv).rgb;
  alb += a * w;
  dn += vec3(n.r * 2.0 - 1.0, 0.0, n.g * 2.0 - 1.0) * w;
  rough += n.b * w;
}

// Cliffs and boulders: triplanar so steep faces are not smeared.
void triplanar(sampler2D A, sampler2D N, vec3 p, vec3 nw, float tile, float w, inout vec3 alb, inout vec3 dn, inout float rough) {
  if (w < 0.003) return;
  vec3 bw = pow(abs(nw), vec3(4.0));
  bw /= bw.x + bw.y + bw.z;
  vec2 ux = p.zy / tile;
  vec2 uy = p.xz / tile;
  vec2 uz = p.xy / tile;
  alb += (texture2D(A, ux).rgb * bw.x + texture2D(A, uy).rgb * bw.y + texture2D(A, uz).rgb * bw.z) * w;
  vec3 tx = texture2D(N, ux).rgb;
  vec3 ty = texture2D(N, uy).rgb;
  vec3 tz = texture2D(N, uz).rgb;
  vec2 nx = tx.rg * 2.0 - 1.0;
  vec2 ny = ty.rg * 2.0 - 1.0;
  vec2 nz = tz.rg * 2.0 - 1.0;
  dn += (vec3(0.0, nx.y, nx.x) * bw.x + vec3(ny.x, 0.0, ny.y) * bw.y + vec3(nz.x, nz.y, 0.0) * bw.z) * w;
  rough += (tx.b * bw.x + ty.b * bw.y + tz.b * bw.z) * w;
}

float terrainSpec(vec3 n, vec3 v, vec3 l, float r) {
  vec3 h = normalize(l + v);
  float a = r * r;
  float a2 = a * a;
  float nh = max(dot(n, h), 0.0);
  float d = nh * nh * (a2 - 1.0) + 1.0;
  float F = 0.04 + 0.96 * pow(1.0 - max(dot(h, v), 0.0), 5.0);
  return a2 / (PI * d * d) * F * 0.25;
}
`;

/**
 * Terrain: material weights come from a per-vertex mask painted by the scene
 * (x = forest, y = extra rock, z = sand/pebble shore, w = dry grass). Close to
 * the viewer, photoscanned ground layers take over; further away the
 * procedural colours (forest canopy, haze) read better than tiled ground.
 */
export function createTerrainMaterial(c: TerrainColors, layers?: TerrainLayers) {
  const L = layers;
  return new ShaderMaterial({
    defines: L ? { USE_LAYERS: '' } : {},
    uniforms: {
      ...globals,
      uGrass: { value: c.grass },
      uForest: { value: c.forest },
      uRock: { value: c.rock },
      uSand: { value: c.sand },
      uBed: { value: c.bed },
      uGroundA: { value: L?.ground.albedo ?? null },
      uGroundN: { value: L?.ground.nrm ?? null },
      uRockA: { value: L?.rock.albedo ?? null },
      uRockN: { value: L?.rock.nrm ?? null },
      uShoreA: { value: L?.shore.albedo ?? null },
      uShoreN: { value: L?.shore.nrm ?? null },
      uBedA: { value: L?.bed.albedo ?? null },
      uBedN: { value: L?.bed.nrm ?? null },
      uGroundTint: { value: new Vector3(...(L?.ground.tint ?? [1, 1, 1])) },
      uTiles: { value: new Vector4(L?.ground.tile ?? 1, L?.rock.tile ?? 1, L?.shore.tile ?? 1, L?.bed.tile ?? 1) },
    },
    vertexShader: /* glsl */ `
      ${APPARENT}
      attribute vec4 aMask;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec4 vMask;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        vMask = aMask;
        gl_Position = projectionMatrix * viewMatrix * vec4(apparentPosition(wp.xyz), 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${GLOBALS}
      uniform vec3 uGrass;
      uniform vec3 uForest;
      uniform vec3 uRock;
      uniform vec3 uSand;
      uniform vec3 uBed;
      #ifdef USE_LAYERS
      ${TERRAIN_LAYERS}
      #endif
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec4 vMask;
      void main() {
        vec3 n = normalize(vNormal);
        vec2 xz = vWorld.xz;
        float dist = length(cameraPosition - vWorld);
        float nLarge = texture2D(uNoiseTex, xz * 0.0023).a;
        float nMid = texture2D(uNoiseTex, xz * 0.021).b;
        float nFine = texture2D(uNoiseTex, xz * 0.27).b;
        float nCanopy = texture2D(uNoiseTex, xz * 0.061).r;
        float slope = 1.0 - n.y;

        float rock = clamp(vMask.y + smoothstep(0.34, 0.56, slope + (nMid - 0.5) * 0.3), 0.0, 1.0);
        float forest = clamp(vMask.x * smoothstep(0.25, 0.55, nLarge * 0.6 + vMask.x * 0.5), 0.0, 1.0) * (1.0 - rock * 0.85);
        float sand = clamp(vMask.z, 0.0, 1.0);
        float under = smoothstep(0.05, -0.4, vWorld.y - uWaterLevel);

        vec3 grass = uGrass * (0.7 + 0.6 * nMid) * mix(vec3(1.0), vec3(1.15, 1.05, 0.7), vMask.w);
        vec3 canopy = uForest * (0.45 + 1.0 * nCanopy * (0.6 + 0.4 * nFine));
        vec3 stone = uRock * (0.62 + 0.75 * nFine * (0.7 + 0.6 * nMid));
        vec3 alb = mix(grass, canopy, forest);
        alb = mix(alb, stone, rock);
        alb = mix(alb, uSand * (0.8 + 0.4 * nFine), sand);
        alb = mix(alb, uBed * (0.75 + 0.5 * nFine), under * 0.75);
        float roughness = 0.85;
        vec3 shadeN = n;

      #ifdef USE_LAYERS
        float detail = 1.0 - smoothstep(30.0, 140.0, dist);
        if (detail > 0.0) {
          // what lies on the ground here: pebbles at the shore, river bed under water, rock on steep faces
          float wBed = under;
          float wShore = sand * (1.0 - wBed);
          float wRock = rock * (1.0 - wBed - wShore);
          float wGround = max(1.0 - wBed - wShore - wRock, 0.0);
          vec3 a = vec3(0.0);
          vec3 dn = vec3(0.0);
          float r = 0.0;
          vec3 ga = vec3(0.0);
          planar(uGroundA, uGroundN, xz, uTiles.x, wGround, ga, dn, r);
          a += ga * uGroundTint;
          triplanar(uRockA, uRockN, vWorld, n, uTiles.y, wRock, a, dn, r);
          planar(uShoreA, uShoreN, xz, uTiles.z, wShore, a, dn, r);
          planar(uBedA, uBedN, xz, uTiles.w, wBed, a, dn, r);
          alb = mix(alb, a, detail);
          roughness = mix(roughness, r, detail);
          shadeN = normalize(n + dn * 0.9 * detail);
        }
        if (detail < 1.0) {
          // far away: the same photographs at landscape scale add strata, gullies and scree
          float far = (1.0 - detail) * (1.0 - smoothstep(2500.0, 7000.0, dist));
          vec3 rockFar = texture2D(uRockA, vWorld.xz / 140.0 + vWorld.y / 300.0).rgb;
          vec3 groundFar = texture2D(uGroundA, vWorld.xz / 90.0).rgb;
          float lum = dot(mix(groundFar, rockFar, rock), vec3(0.3333)) / 0.18;
          alb *= mix(1.0, clamp(lum, 0.45, 1.8), far * 0.75);
          vec3 nf = texture2D(uRockN, vWorld.xz / 140.0 + vWorld.y / 300.0).rgb;
          shadeN = normalize(shadeN + vec3(nf.r * 2.0 - 1.0, 0.0, nf.g * 2.0 - 1.0) * far * 0.6 * (0.4 + rock));
        }
      #endif

        float wet = (1.0 - smoothstep(0.0, 0.55, vWorld.y - uWaterLevel)) * (1.0 - under);
        alb *= 1.0 - 0.38 * wet;
        roughness = mix(roughness, 0.3, wet * 0.8);

        float ao = mix(1.0, 0.55 + 0.45 * nCanopy, forest * (1.0 - (1.0 - smoothstep(30.0, 140.0, dist)) * 0.7));
        float ndl = dot(shadeN, uSunDir);
        float diff = mix(max(ndl, 0.0), clamp((ndl + 0.25) / 1.25, 0.0, 1.0) * 0.85, forest);
        float diffM = max(dot(shadeN, uMoonDir), 0.0);
        vec3 light = uSunColor * diff * mix(1.0, ao, 0.5) + uMoonColor * diffM + hemiAmbient(shadeN) * ao;
        vec3 col = alb * light;
      #ifdef USE_LAYERS
        vec3 V = normalize(cameraPosition - vWorld);
        col += uSunColor * terrainSpec(shadeN, V, uSunDir, roughness) * max(ndl, 0.0);
      #endif
        if (vWorld.y < uWaterLevel) {
          col += alb * uSunColor * caustics(xz, uWaterLevel - vWorld.y) * max(uSunDir.y, 0.0) * 0.6;
        }
        col = applyUnderwater(col, vWorld);
        col = applyFog(col, vWorld);
        gl_FragColor = vec4(col, 1.0);
        ${OUTPUT}
      }
    `,
  });
}

export type LitKind = 'plain' | 'rock' | 'foliage' | 'wood';

export interface LitOptions {
  kind: LitKind;
  moss?: Color;
  mossAmount?: number;
  sway?: number;
  doubleSide?: boolean;
}

/** Generic lit material for props: rocks, stones, trees, the dock. Uses vertex/instance colours. */
export function createLitMaterial(o: LitOptions) {
  const defines: Record<string, string> = { [`KIND_${o.kind.toUpperCase()}`]: '' };
  return new ShaderMaterial({
    defines,
    vertexColors: true,
    ...(o.doubleSide ? { side: DoubleSide } : {}),
    uniforms: {
      ...globals,
      uMoss: { value: o.moss ?? new Color(0.05, 0.08, 0.03) },
      uMossAmount: { value: o.mossAmount ?? 0 },
      uSway: { value: o.sway ?? 0 },
      uOpacity: { value: 1 },
    },
    vertexShader: /* glsl */ `
      ${APPARENT}
      uniform float uTime;
      uniform float uSway;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec3 vColor;
      varying vec3 vLocal;
      void main() {
        mat4 m = modelMatrix;
      #ifdef USE_INSTANCING
        m = modelMatrix * instanceMatrix;
      #endif
        vec4 wp = m * vec4(position, 1.0);
      #ifdef KIND_FOLIAGE
        vec3 base = (m * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        float hgt = max(wp.y - base.y, 0.0);
        float ph = base.x * 0.071 + base.z * 0.053;
        float gust = 0.6 + 0.4 * sin(uTime * 0.31 + base.x * 0.01);
        wp.x += sin(uTime * 1.31 + ph) * uSway * hgt * hgt * 0.0025 * gust;
        wp.z += cos(uTime * 1.07 + ph * 1.3) * uSway * hgt * hgt * 0.0018 * gust;
      #endif
        vWorld = wp.xyz;
        vNormal = normalize(mat3(m) * normal);
        vColor = color;
      #ifdef USE_INSTANCING_COLOR
        vColor *= instanceColor;
      #endif
        vLocal = position;
        gl_Position = projectionMatrix * viewMatrix * vec4(apparentPosition(wp.xyz), 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${GLOBALS}
      uniform vec3 uMoss;
      uniform float uMossAmount;
      uniform float uOpacity;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec3 vColor;
      varying vec3 vLocal;
      void main() {
        vec3 n = normalize(vNormal);
        if (!gl_FrontFacing) n = -n;
        vec3 alb = vColor;
        float ao = 1.0;
      #ifdef KIND_ROCK
        vec3 an = abs(n);
        vec3 w = an / (an.x + an.y + an.z);
        float t = texture2D(uNoiseTex, vWorld.yz * 0.31).b * w.x + texture2D(uNoiseTex, vWorld.xz * 0.31).b * w.y + texture2D(uNoiseTex, vWorld.xy * 0.31).b * w.z;
        float t2 = texture2D(uNoiseTex, vWorld.xz * 0.07 + vWorld.y * 0.05).a;
        alb *= 0.55 + 0.9 * t * (0.7 + 0.6 * t2);
        float moss = smoothstep(0.35, 0.85, n.y + (t2 - 0.5) * 0.6) * uMossAmount;
        alb = mix(alb, uMoss * (0.7 + 0.6 * t), moss);
        float wet = 1.0 - smoothstep(0.0, 0.45, vWorld.y - uWaterLevel);
        alb *= 1.0 - 0.45 * wet;
      #endif
      #ifdef KIND_WOOD
        float grain = texture2D(uNoiseTex, vec2(vWorld.x * 0.08 + vWorld.y * 0.05, vWorld.z * 0.9)).b;
        alb *= 0.65 + 0.6 * grain;
      #endif
      #ifdef KIND_FOLIAGE
        ao = clamp(0.45 + vLocal.y * 0.06, 0.45, 1.0);
        float nv = texture2D(uNoiseTex, vWorld.xz * 0.9 + vWorld.y * 0.7).b;
        alb *= 0.75 + 0.5 * nv;
      #endif
        float ndl = dot(n, uSunDir);
        float ndlm = dot(n, uMoonDir);
        vec3 light;
      #ifdef KIND_FOLIAGE
        vec3 V = normalize(cameraPosition - vWorld);
        float back = pow(max(dot(-V, uSunDir), 0.0), 5.0) * 0.5;
        light = uSunColor * (clamp((ndl + 0.4) / 1.4, 0.0, 1.0) * 0.85 + back) * ao
              + uMoonColor * clamp((ndlm + 0.4) / 1.4, 0.0, 1.0)
              + hemiAmbient(n) * ao;
      #else
        light = uSunColor * max(ndl, 0.0) + uMoonColor * max(ndlm, 0.0) + hemiAmbient(n) * ao;
      #endif
        vec3 col = alb * light;
        if (vWorld.y < uWaterLevel) {
          col += alb * uSunColor * caustics(vWorld.xz, uWaterLevel - vWorld.y) * max(uSunDir.y, 0.0) * 0.6;
        }
        col = applyUnderwater(col, vWorld);
        col = applyFog(col, vWorld);
        gl_FragColor = vec4(col, uOpacity);
        ${OUTPUT}
      }
    `,
  });
}
