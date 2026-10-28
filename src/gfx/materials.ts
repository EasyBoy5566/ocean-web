import { Color, DoubleSide, ShaderMaterial } from 'three';
import { APPARENT, GLOBALS, OUTPUT } from './glsl';
import { globals } from './globals';

export interface TerrainColors {
  grass: Color;
  forest: Color;
  rock: Color;
  sand: Color;
  bed: Color;
}

/**
 * Terrain: material weights come from a per-vertex mask painted by the scene
 * (x = forest, y = extra rock, z = sand/pebble shore, w = snow/dry grass) and
 * are broken up with tiled noise so the low-poly mesh reads as detailed ground.
 */
export function createTerrainMaterial(c: TerrainColors) {
  return new ShaderMaterial({
    uniforms: {
      ...globals,
      uGrass: { value: c.grass },
      uForest: { value: c.forest },
      uRock: { value: c.rock },
      uSand: { value: c.sand },
      uBed: { value: c.bed },
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
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec4 vMask;
      void main() {
        vec3 n = normalize(vNormal);
        vec2 xz = vWorld.xz;
        float nLarge = texture2D(uNoiseTex, xz * 0.0023).a;
        float nMid = texture2D(uNoiseTex, xz * 0.021).b;
        float nFine = texture2D(uNoiseTex, xz * 0.27).b;
        float nCanopy = texture2D(uNoiseTex, xz * 0.061).r;
        float slope = 1.0 - n.y;

        float rock = clamp(vMask.y + smoothstep(0.34, 0.56, slope + (nMid - 0.5) * 0.3), 0.0, 1.0);
        float forest = clamp(vMask.x * smoothstep(0.25, 0.55, nLarge * 0.6 + vMask.x * 0.5), 0.0, 1.0) * (1.0 - rock * 0.85);
        float sand = clamp(vMask.z, 0.0, 1.0);

        vec3 grass = uGrass * (0.7 + 0.6 * nMid) * mix(vec3(1.0), vec3(1.15, 1.05, 0.7), vMask.w);
        vec3 canopy = uForest * (0.45 + 1.0 * nCanopy * (0.6 + 0.4 * nFine));
        vec3 stone = uRock * (0.62 + 0.75 * nFine * (0.7 + 0.6 * nMid));
        vec3 alb = mix(grass, canopy, forest);
        alb = mix(alb, stone, rock);
        alb = mix(alb, uSand * (0.8 + 0.4 * nFine), sand);
        float under = smoothstep(0.05, -0.4, vWorld.y - uWaterLevel);
        alb = mix(alb, uBed * (0.75 + 0.5 * nFine), under * 0.75);
        float wet = (1.0 - smoothstep(0.0, 0.55, vWorld.y - uWaterLevel)) * (1.0 - under);
        alb *= 1.0 - 0.38 * wet;

        float ao = mix(1.0, 0.55 + 0.45 * nCanopy, forest);
        float ndl = dot(n, uSunDir);
        float diff = mix(max(ndl, 0.0), clamp((ndl + 0.25) / 1.25, 0.0, 1.0) * 0.85, forest);
        float diffM = max(dot(n, uMoonDir), 0.0);
        vec3 light = uSunColor * diff * mix(1.0, ao, 0.5) + uMoonColor * diffM + hemiAmbient(n) * ao;
        vec3 col = alb * light;
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
