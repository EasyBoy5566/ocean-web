import {
  BoxGeometry, BufferGeometry, Color, ConeGeometry, CylinderGeometry, Float32BufferAttribute, IcosahedronGeometry,
  InstancedMesh, Matrix4, Quaternion, Vector3, type Material,
} from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../util/math';
import { Noise2D } from '../util/noise';

function paint(geo: BufferGeometry, c: Color): BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  return g;
}

/** Bends normals away from the trunk axis so foliage shades like a soft volume. */
function softenFoliage(geo: BufferGeometry, centerY: number, amount: number) {
  const p = geo.attributes.position;
  const n = geo.attributes.normal;
  const v = new Vector3();
  const o = new Vector3();
  for (let i = 0; i < p.count; i++) {
    o.set(p.getX(i), (p.getY(i) - centerY) * 0.6, p.getZ(i)).normalize();
    v.set(n.getX(i), n.getY(i), n.getZ(i)).lerp(o, amount).normalize();
    n.setXYZ(i, v.x, v.y, v.z);
  }
}

/** A conifer about 1 unit tall at scale 1 (origin at the base of the trunk). */
export function createConiferGeometry(seed = 1): BufferGeometry {
  const rnd = mulberry32(seed);
  const parts: BufferGeometry[] = [];
  const trunk = new CylinderGeometry(0.012, 0.02, 0.3, 5, 1, true);
  trunk.translate(0, 0.15, 0);
  parts.push(paint(trunk, new Color(0.11, 0.08, 0.055)));
  const tiers = 6;
  for (let i = 0; i < tiers; i++) {
    const f = i / (tiers - 1);
    const r = 0.21 * (1 - f * 0.78);
    const h = 0.3 - f * 0.12;
    const cone = new ConeGeometry(r, h, 9, 2, true);
    // Ragged, drooping branch tips so silhouettes do not read as perfect cones.
    const p = cone.attributes.position;
    const phase = rnd() * 10;
    for (let k = 0; k < p.count; k++) {
      const x = p.getX(k), y = p.getY(k), z = p.getZ(k);
      const rim = (h / 2 - y) / h;
      const ang = Math.atan2(z, x);
      const jag = 1 + (Math.sin(ang * 4 + phase) * 0.5 + Math.sin(ang * 7 - phase * 1.7) * 0.5) * 0.16 * rim;
      p.setXYZ(k, x * jag, y - rim * rim * 0.03 * jag, z * jag);
    }
    cone.computeVertexNormals();
    cone.translate(0, 0.2 + f * 0.62 + h / 2, 0);
    cone.rotateY(rnd() * Math.PI);
    const g = paint(cone, new Color(0.028 + f * 0.012, 0.055 + f * 0.016, 0.034 + f * 0.006));
    softenFoliage(g, 0.55, 0.5);
    parts.push(g);
  }
  const merged = mergeGeometries(parts)!;
  merged.computeBoundingSphere();
  return merged;
}

/** A rounded broadleaf tree about 1 unit tall. */
export function createBroadleafGeometry(seed: number): BufferGeometry {
  const rnd = mulberry32(seed);
  const noise = new Noise2D(seed);
  const parts: BufferGeometry[] = [];
  const trunk = new CylinderGeometry(0.018, 0.03, 0.45, 5, 1, true);
  trunk.translate(0, 0.225, 0);
  parts.push(paint(trunk, new Color(0.12, 0.09, 0.07)));
  const blobs = 4 + Math.floor(rnd() * 3);
  for (let i = 0; i < blobs; i++) {
    const r = 0.13 + rnd() * 0.1;
    const blob = new IcosahedronGeometry(r, 1);
    const p = blob.attributes.position;
    for (let k = 0; k < p.count; k++) {
      const x = p.getX(k), y = p.getY(k), z = p.getZ(k);
      const d = 1 + 0.22 * noise.noise(x * 9 + i, z * 9 + y * 7);
      p.setXYZ(k, x * d, y * d * 0.85, z * d);
    }
    blob.computeVertexNormals();
    const a = rnd() * Math.PI * 2;
    const rr = i === 0 ? 0 : 0.08 + rnd() * 0.1;
    blob.translate(Math.cos(a) * rr, 0.55 + rnd() * 0.25 + (i === 0 ? 0.08 : 0), Math.sin(a) * rr);
    const g = paint(blob, new Color(0.05 + rnd() * 0.02, 0.095 + rnd() * 0.03, 0.035));
    softenFoliage(g, 0.65, 0.5);
    parts.push(g);
  }
  const merged = mergeGeometries(parts)!;
  merged.computeBoundingSphere();
  return merged;
}

/** Irregular boulder of radius ~1, smooth-shaded. */
export function createRockGeometry(seed: number, detail = 2, flatten = 0.7): BufferGeometry {
  const noise = new Noise2D(seed);
  let geo: BufferGeometry = new IcosahedronGeometry(1, detail);
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  geo = mergeVertices(geo);
  const p = geo.attributes.position;
  const rnd = mulberry32(seed * 7 + 1);
  const sx = 0.8 + rnd() * 0.5, sz = 0.8 + rnd() * 0.5;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n =
      noise.noise(x * 1.3 + 3.1, y * 1.3) * 0.18 +
      noise.noise(y * 1.7 - 2.2, z * 1.7) * 0.18 +
      noise.noise(z * 2.9, x * 2.9 + 5.5) * 0.08;
    const d = 1 + n;
    // flatten the base so rocks sit on the ground
    const yy = y < -0.3 ? -0.3 + (y + 0.3) * 0.35 : y;
    p.setXYZ(i, x * d * sx, yy * d * flatten, z * d * sz);
  }
  geo.computeVertexNormals();
  const g = geo.toNonIndexed();
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3).fill(1);
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}

export function setGeometryColor(geo: BufferGeometry, c: Color): BufferGeometry {
  const col = geo.attributes.color;
  for (let i = 0; i < col.count; i++) col.setXYZ(i, c.r, c.g, c.b);
  col.needsUpdate = true;
  return geo;
}

export function createBoxGeometry(w: number, h: number, d: number, color: Color): BufferGeometry {
  return paint(new BoxGeometry(w, h, d), color);
}

export interface Placement {
  x: number;
  y: number;
  z: number;
  scale: number | [number, number, number];
  rotY?: number;
  tilt?: [number, number];
  color?: Color;
}

const _m = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _e = new Vector3();
const _up = new Vector3(0, 1, 0);

export function createInstances(geo: BufferGeometry, material: Material, items: Placement[]): InstancedMesh {
  const mesh = new InstancedMesh(geo, material, Math.max(items.length, 1));
  mesh.count = items.length;
  const tmpQ = new Quaternion();
  items.forEach((it, i) => {
    _p.set(it.x, it.y, it.z);
    if (Array.isArray(it.scale)) _s.set(...it.scale);
    else _s.setScalar(it.scale);
    _q.setFromAxisAngle(_up, it.rotY ?? 0);
    if (it.tilt) {
      _e.set(it.tilt[0], 0, it.tilt[1]);
      const ang = _e.length();
      if (ang > 0) {
        tmpQ.setFromAxisAngle(_e.normalize(), ang);
        _q.premultiply(tmpQ);
      }
    }
    _m.compose(_p, _q, _s);
    mesh.setMatrixAt(i, _m);
    if (it.color) mesh.setColorAt(i, it.color);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false;
  return mesh;
}
