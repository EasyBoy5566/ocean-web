import {
  Color, DoubleSide, DynamicDrawUsage, Float32BufferAttribute, InstancedBufferAttribute, InstancedBufferGeometry,
  InstancedMesh, Matrix3, Matrix4, Mesh, Quaternion, ShaderMaterial, Vector2, Vector3, type BufferGeometry,
  type MeshStandardMaterial, type Object3D,
} from 'three';
import { MeshStandardMaterial as StdMat } from 'three';
import type { GroundLayer, ImpostorAtlas } from './assets';
import { APPARENT, GLOBALS, OUTPUT } from './glsl';
import { globals } from './globals';

/**
 * Shading for photoscanned assets (Poly Haven) under this project's own sky
 * light: albedo, tangent-space normals (tangents rebuilt from screen-space
 * derivatives, so none are stored), roughness and occlusion from the ARM map.
 */

const COTANGENT = /* glsl */ `
mat3 cotangentFrame(vec3 N, vec3 p, vec2 uv) {
  vec3 dp1 = dFdx(p);
  vec3 dp2 = dFdy(p);
  vec2 duv1 = dFdx(uv);
  vec2 duv2 = dFdy(uv);
  vec3 dp2perp = cross(dp2, N);
  vec3 dp1perp = cross(N, dp1);
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float invmax = inversesqrt(max(max(dot(T, T), dot(B, B)), 1e-12));
  return mat3(T * invmax, B * invmax, N);
}
`;

const LIGHTING = /* glsl */ `
float ggx(vec3 n, vec3 v, vec3 l, float rough) {
  vec3 h = normalize(l + v);
  float a = rough * rough;
  float a2 = a * a;
  float nh = max(dot(n, h), 0.0);
  float d = nh * nh * (a2 - 1.0) + 1.0;
  float nl = max(dot(n, l), 0.0);
  float nv = max(dot(n, v), 1e-3);
  float k = a * 0.5;
  float G = (nl / (nl * (1.0 - k) + k)) * (nv / (nv * (1.0 - k) + k));
  float F = 0.04 + 0.96 * pow(1.0 - max(dot(h, v), 0.0), 5.0);
  return a2 / (PI * d * d) * G * F / (4.0 * nv);
}

/** Diffuse + specular from sun and moon plus sky ambient; wrap > 0 softens foliage. */
vec3 shade(vec3 alb, vec3 n, vec3 V, float rough, float ao, float wrap) {
  float ndl = dot(n, uSunDir);
  float ndm = dot(n, uMoonDir);
  float dS = clamp((ndl + wrap) / (1.0 + wrap), 0.0, 1.0);
  float dM = clamp((ndm + wrap) / (1.0 + wrap), 0.0, 1.0);
  vec3 col = alb * (uSunColor * dS + uMoonColor * dM + hemiAmbient(n) * ao);
  col += uSunColor * ggx(n, V, uSunDir, rough) * max(ndl, 0.0) * ao;
  col += uMoonColor * ggx(n, V, uMoonDir, rough) * max(ndm, 0.0) * ao;
  return col;
}
`;

export interface ScannedOptions {
  /** Foliage: soft wrap lighting, wind sway, alpha-tested and double sided. */
  foliage?: boolean;
  sway?: number;
  /** Map UVs from world XZ instead of mesh UVs (metres per repeat). */
  worldUV?: number;
  /** Project the textures from all three axes in world space (metres per repeat). */
  triplanar?: number;
  /** Normal map packed as RG = normal, B = roughness (ground layers), instead of glTF RGB + ARM. */
  packed?: boolean;
  /** With worldUV: map Z to U and X to V (turns the texture a quarter). */
  swapUV?: boolean;
}

export function createScannedMaterial(src: MeshStandardMaterial, o: ScannedOptions = {}) {
  // Quantised glTFs restore their UV range through KHR_texture_transform, which
  // three.js stores in the texture matrix; apply it like the built-in materials do.
  src.map?.updateMatrix();
  const uvTransform = src.map ? src.map.matrix.clone() : new Matrix3();
  const defines: Record<string, string> = {};
  if (o.foliage) defines.FOLIAGE = '';
  if (o.worldUV) defines.WORLD_UV = '';
  if (o.triplanar) defines.TRIPLANAR = '';
  if (o.packed) defines.PACKED = '';
  if (o.swapUV) defines.SWAP_UV = '';
  return new ShaderMaterial({
    defines,
    ...(o.foliage ? { side: DoubleSide } : {}),
    alphaToCoverage: !!o.foliage,
    uniforms: {
      ...globals,
      uMap: { value: src.map },
      uNormalMap: { value: src.normalMap },
      uArm: { value: src.roughnessMap ?? src.aoMap },
      uHasNormal: { value: src.normalMap ? 1 : 0 },
      uHasArm: { value: src.roughnessMap || src.aoMap ? 1 : 0 },
      uTint: { value: new Color(1, 1, 1) },
      uSway: { value: o.sway ?? 0 },
      uWorldUV: { value: o.worldUV ?? o.triplanar ?? 1 },
      uUvTransform: { value: uvTransform },
    },
    vertexShader: /* glsl */ `
      ${APPARENT}
      uniform float uTime;
      uniform float uSway;
      uniform mat3 uUvTransform;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec2 vUv;
      varying vec3 vInst;
      void main() {
        mat4 m = modelMatrix;
      #ifdef USE_INSTANCING
        m = modelMatrix * instanceMatrix;
      #endif
        vec4 wp = m * vec4(position, 1.0);
      #ifdef FOLIAGE
        vec3 base = (m * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        float hgt = max(wp.y - base.y, 0.0);
        float ph = base.x * 1.7 + base.z * 1.3;
        wp.xz += vec2(sin(uTime * 2.1 + ph), cos(uTime * 1.7 + ph)) * uSway * hgt * hgt;
      #endif
        vWorld = wp.xyz;
        vNormal = normalize(mat3(m) * normal);
        vUv = (uUvTransform * vec3(uv, 1.0)).xy;
        vInst = vec3(1.0);
      #ifdef USE_INSTANCING_COLOR
        vInst = instanceColor;
      #endif
        gl_Position = projectionMatrix * viewMatrix * vec4(apparentPosition(wp.xyz), 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${GLOBALS}
      ${COTANGENT}
      ${LIGHTING}
      uniform sampler2D uMap;
      uniform sampler2D uNormalMap;
      uniform sampler2D uArm;
      uniform float uHasNormal;
      uniform float uHasArm;
      uniform vec3 uTint;
      uniform float uWorldUV;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec2 vUv;
      varying vec3 vInst;
      void main() {
      #if defined(WORLD_UV) && defined(SWAP_UV)
        vec2 uv = vWorld.zx / uWorldUV;
      #elif defined(WORLD_UV)
        vec2 uv = vWorld.xz / uWorldUV;
      #else
        vec2 uv = vUv;
      #endif
        vec3 N = normalize(vNormal);
        if (!gl_FrontFacing) N = -N;
      #ifdef TRIPLANAR
        vec3 bw = pow(abs(N), vec3(4.0));
        bw /= bw.x + bw.y + bw.z;
        vec2 ux = vWorld.zy / uWorldUV;
        vec2 uy = vWorld.xz / uWorldUV;
        vec2 uz = vWorld.xy / uWorldUV;
        vec4 base = texture2D(uMap, ux) * bw.x + texture2D(uMap, uy) * bw.y + texture2D(uMap, uz) * bw.z;
        vec3 tx = texture2D(uNormalMap, ux).rgb;
        vec3 ty = texture2D(uNormalMap, uy).rgb;
        vec3 tz = texture2D(uNormalMap, uz).rgb;
        vec3 dn = vec3(0.0, tx.g * 2.0 - 1.0, tx.r * 2.0 - 1.0) * bw.x
                + vec3(ty.r * 2.0 - 1.0, 0.0, ty.g * 2.0 - 1.0) * bw.y
                + vec3(tz.r * 2.0 - 1.0, tz.g * 2.0 - 1.0, 0.0) * bw.z;
        vec3 n = normalize(N + dn * 0.9);
        vec3 arm = vec3(1.0, tx.b * bw.x + ty.b * bw.y + tz.b * bw.z, 0.0);
        float alpha = 1.0;
      #else
        vec4 base = texture2D(uMap, uv);
      #ifdef FOLIAGE
        // sharpened alpha for alpha-to-coverage: crisp edges that survive mipmapping
        float alpha = (base.a - 0.5) / max(fwidth(base.a), 1e-4) + 0.5;
        if (alpha < 0.02) discard;
      #else
        float alpha = 1.0;
      #endif
        vec3 n = N;
        vec3 arm = vec3(1.0, 0.8, 0.0);
        if (uHasNormal > 0.5) {
          vec3 t = texture2D(uNormalMap, uv).xyz;
      #ifdef PACKED
          arm.g = t.b;
          vec2 txy = t.rg * 2.0 - 1.0;
          t = vec3(txy, sqrt(max(1.0 - dot(txy, txy), 0.0)));
      #else
          t = t * 2.0 - 1.0;
      #endif
          n = normalize(cotangentFrame(N, vWorld, uv) * t);
        }
        if (uHasArm > 0.5) arm = texture2D(uArm, uv).rgb;
      #endif
        vec3 alb = base.rgb * uTint * vInst;
        // dark wet band near the waterline
        float wet = 1.0 - smoothstep(0.0, 0.5, vWorld.y - uWaterLevel);
        alb *= 1.0 - 0.4 * wet;
        float rough = mix(arm.g, 0.25, wet);
        vec3 V = normalize(cameraPosition - vWorld);
      #ifdef FOLIAGE
        vec3 col = shade(alb, n, V, max(rough, 0.5), arm.r, 0.45);
        col += alb * uSunColor * pow(max(dot(-V, uSunDir), 0.0), 4.0) * 0.6;
      #else
        vec3 col = shade(alb, n, V, rough, arm.r, 0.0);
      #endif
        if (vWorld.y < uWaterLevel) col += alb * uSunColor * caustics(vWorld.xz, uWaterLevel - vWorld.y) * max(uSunDir.y, 0.0) * 0.6;
        col = applyUnderwater(col, vWorld);
        col = applyFog(col, vWorld);
        gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
        ${OUTPUT}
      }
    `,
  });
}

/** A ground layer (albedo + packed normal/roughness) applied to arbitrary meshes. */
export function createLayerMaterial(layer: GroundLayer, o: { triplanar?: boolean; worldUV?: boolean; swapUV?: boolean } = {}) {
  const src = new StdMat({ map: layer.albedo, normalMap: layer.nrm });
  return createScannedMaterial(src, {
    packed: true,
    swapUV: o.swapUV,
    triplanar: o.triplanar ? layer.tile : undefined,
    worldUV: o.worldUV ? layer.tile : undefined,
  });
}

export interface ScatterItem {
  x: number;
  y: number;
  z: number;
  /** Uniform or per-axis scale relative to the source mesh. */
  scale: number | [number, number, number];
  rotY?: number;
  tilt?: [number, number];
  tint?: Color;
}

/** One mesh of a scanned model, instanced over many placements. */
export function scatter(geo: BufferGeometry, material: ShaderMaterial, items: ScatterItem[]): InstancedMesh {
  const mesh = new InstancedMesh(geo, material, Math.max(items.length, 1));
  mesh.count = items.length;
  const m = new Matrix4(), q = new Quaternion(), tq = new Quaternion(), p = new Vector3(), s = new Vector3(), e = new Vector3();
  const up = new Vector3(0, 1, 0);
  items.forEach((it, i) => {
    p.set(it.x, it.y, it.z);
    if (Array.isArray(it.scale)) s.set(...it.scale);
    else s.setScalar(it.scale);
    q.setFromAxisAngle(up, it.rotY ?? 0);
    if (it.tilt) {
      e.set(it.tilt[0], 0, it.tilt[1]);
      const ang = e.length();
      if (ang > 0) q.premultiply(tq.setFromAxisAngle(e.normalize(), ang));
    }
    mesh.setMatrixAt(i, m.compose(p, q, s));
    mesh.setColorAt(i, it.tint ?? new Color(1, 1, 1));
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false;
  return mesh;
}

/** Meshes of a loaded glTF scene, each with its geometry recentred on its base and its bounds. */
/** Scanned rocks whose simplified UVs came out smeared; skipped when scattering. */
const BROKEN_PARTS = /rock_moss_set_01_rock0[23]/;

export function meshParts(root: Object3D): { geometry: BufferGeometry; material: MeshStandardMaterial; size: Vector3; name: string }[] {
  const out: { geometry: BufferGeometry; material: MeshStandardMaterial; size: Vector3; name: string }[] = [];
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh || BROKEN_PARTS.test(mesh.name)) return;
    const g = mesh.geometry.clone();
    // bake rotation/scale of the node but not its placement in the source file
    const rot = new Matrix4().extractRotation(mesh.matrixWorld);
    const sc = new Vector3().setFromMatrixScale(mesh.matrixWorld);
    g.applyMatrix4(new Matrix4().makeScale(sc.x, sc.y, sc.z).premultiply(rot));
    g.computeBoundingBox();
    const bb = g.boundingBox!;
    const c = bb.getCenter(new Vector3());
    g.translate(-c.x, -bb.min.y, -c.z);
    out.push({ geometry: g, material: mesh.material as MeshStandardMaterial, size: bb.getSize(new Vector3()), name: mesh.name });
  });
  return out;
}

export interface TreeItem {
  x: number;
  y: number;
  z: number;
  height: number;
  frame: number;
  flip: boolean;
  tint: Color;
}

/**
 * Trees as camera-facing billboards baked from photoscanned models: colour
 * and coverage in one atlas, view-space normal + depth in another, so they are
 * lit by the real sun direction and darken inside the crown.
 */
export function createImpostors(atlas: ImpostorAtlas, items: TreeItem[], sway = 1): Mesh {
  const geo = new InstancedBufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const n = Math.max(items.length, 1);
  const pos = new Float32Array(n * 3), scale = new Float32Array(n), frame = new Float32Array(n), tint = new Float32Array(n * 3);
  items.forEach((t, i) => {
    pos.set([t.x, t.y, t.z], i * 3);
    scale[i] = (t.height / atlas.worldHeight) * (t.flip ? -1 : 1);
    frame[i] = t.frame % atlas.frames;
    tint.set([t.tint.r, t.tint.g, t.tint.b], i * 3);
  });
  geo.setAttribute('iPos', new InstancedBufferAttribute(pos, 3).setUsage(DynamicDrawUsage));
  geo.setAttribute('iScale', new InstancedBufferAttribute(scale, 1));
  geo.setAttribute('iFrame', new InstancedBufferAttribute(frame, 1));
  geo.setAttribute('iTint', new InstancedBufferAttribute(tint, 3));
  geo.instanceCount = items.length;
  const material = new ShaderMaterial({
    alphaToCoverage: true,
    uniforms: {
      ...globals,
      uColor: { value: atlas.color },
      uNormal: { value: atlas.normal },
      uFrames: { value: atlas.frames },
      uWorld: { value: new Vector2(atlas.worldWidth, atlas.worldHeight) },
      uBase: { value: atlas.base },
      uSway: { value: sway },
    },
    vertexShader: /* glsl */ `
      attribute vec3 iPos;
      attribute float iScale;
      attribute float iFrame;
      attribute vec3 iTint;
      uniform float uTime;
      uniform float uFrames;
      uniform vec2 uWorld;
      uniform float uBase;
      uniform float uSway;
      varying vec2 vUv;
      varying vec3 vWorld;
      varying vec3 vRight;
      varying vec3 vFwd;
      varying vec3 vTint;
      void main() {
        vec3 toCam = cameraPosition - iPos;
        toCam.y = 0.0;
        vec3 fwd = normalize(toCam + vec3(1e-4, 0.0, 0.0));
        vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), fwd));
        float s = abs(iScale);
        vec3 p = iPos + right * position.x * uWorld.x * s + vec3(0.0, position.y * uWorld.y * s - uBase * s, 0.0);
        // crowns lean in the wind; trunks stay put
        float h = position.y * position.y;
        float ph = iPos.x * 0.13 + iPos.z * 0.07;
        p.xz += vec2(sin(uTime * 0.8 + ph) + 0.4 * sin(uTime * 2.3 + ph * 2.0), cos(uTime * 0.6 + ph)) * 0.012 * uWorld.y * s * h * uSway;
        float u = iScale < 0.0 ? 0.5 - position.x : position.x + 0.5;
        vUv = vec2((iFrame + u) / uFrames, position.y);
        vWorld = p;
        vRight = right * sign(iScale);
        vFwd = fwd;
        vTint = iTint;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${GLOBALS}
      uniform sampler2D uColor;
      uniform sampler2D uNormal;
      varying vec2 vUv;
      varying vec3 vWorld;
      varying vec3 vRight;
      varying vec3 vFwd;
      varying vec3 vTint;
      void main() {
        vec4 c = texture2D(uColor, vUv);
        float alpha = (c.a - 0.5) / max(fwidth(c.a), 1e-4) + 0.5;
        if (alpha < 0.02) discard;
        vec3 nd = texture2D(uNormal, vUv).rgb;
        vec2 nxy = nd.rg * 2.0 - 1.0;
        vec3 nv = vec3(nxy, sqrt(max(1.0 - dot(nxy, nxy), 0.0)));
        vec3 n = normalize(vRight * nv.x + vec3(0.0, 1.0, 0.0) * nv.y + vFwd * nv.z);
        // deeper inside the crown means more self-shadowing
        float ao = mix(1.0, 0.22, smoothstep(0.2, 0.8, nd.b));
        vec3 V = normalize(cameraPosition - vWorld);
        float ndl = dot(n, uSunDir);
        float diff = clamp((ndl + 0.35) / 1.35, 0.0, 1.0) * mix(1.0, ao, 0.6);
        float back = pow(max(dot(-V, uSunDir), 0.0), 4.0) * (1.0 - nd.b) * 0.35;
        float ndm = clamp((dot(n, uMoonDir) + 0.35) / 1.35, 0.0, 1.0);
        // calibrated against the terrain: photographed foliage already holds some light
        vec3 alb = c.rgb * vTint * vec3(0.5, 0.55, 0.5);
        vec3 col = alb * (uSunColor * (diff + back) + uMoonColor * ndm + hemiAmbient(n) * ao);
        col = applyFog(col, vWorld);
        gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
        ${OUTPUT}
      }
    `,
  });
  const mesh = new Mesh(geo, material);
  mesh.frustumCulled = false;
  return mesh;
}

