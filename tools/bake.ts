// Bakes billboard impostors of scanned trees: per view, an albedo+coverage image
// and a view-space normal+depth image, laid side by side in two atlases.
// Driven by tools/bake.mjs in headless Edge; run against the Vite dev server.
import {
  Box3, DoubleSide, MeshBasicMaterial, NoToneMapping, OrthographicCamera, Scene, ShaderMaterial,
  SRGBColorSpace, Vector3, WebGLRenderer, type Material, type Mesh, type MeshStandardMaterial, type Object3D,
  type Texture,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

interface BakeOptions { node?: string; frames: number; width: number; height: number }
interface BakeResult { color: string; normal: string; worldWidth: number; worldHeight: number; base: number; frames: number }

const canvas = document.getElementById('c') as HTMLCanvasElement;
const cache = new Map<string, Promise<Object3D>>();

function load(url: string) {
  let p = cache.get(url);
  if (!p) {
    p = new GLTFLoader().loadAsync(url).then((g) => g.scene);
    cache.set(url, p);
  }
  return p;
}

const normalMat = (map: Texture | null, alphaTest: number) =>
  new ShaderMaterial({
    uniforms: { uMap: { value: map }, uAlphaTest: { value: alphaTest }, uNear: { value: 0 }, uFar: { value: 1 } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec2 vUv; varying float vZ;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal); vUv = uv; vZ = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap; uniform float uAlphaTest; uniform float uNear; uniform float uFar;
      varying vec3 vN; varying vec2 vUv; varying float vZ;
      void main() {
        if (uAlphaTest > 0.0 && texture2D(uMap, vUv).a < uAlphaTest) discard;
        vec3 n = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);
        // RG = normal x/y (z is rebuilt, facing the viewer), B = depth; alpha stays 1 so the
        // canvas' premultiplied alpha cannot distort the values
        gl_FragColor = vec4(n.xy * 0.5 + 0.5, clamp((vZ - uNear) / (uFar - uNear), 0.0, 1.0), 1.0);
      }`,
    side: DoubleSide,
  });

async function bake(url: string, o: BakeOptions): Promise<BakeResult> {
  const source = await load(url);
  const target = o.node ? source.getObjectByName(o.node) : source;
  if (!target) throw new Error(`node ${o.node} not found`);
  const obj = target.clone(true);
  obj.position.set(0, 0, 0);
  obj.updateMatrixWorld(true);
  const box = new Box3().setFromObject(obj);
  const c = box.getCenter(new Vector3());
  obj.position.set(-c.x, -box.min.y, -c.z);
  obj.updateMatrixWorld(true);
  const size = box.getSize(new Vector3());
  const radius = Math.hypot(size.x, size.z) / 2;
  const aspect = o.width / o.height;
  const worldHeight = Math.max(size.y, (2 * radius) / aspect) * 1.03;
  const worldWidth = worldHeight * aspect;
  const base = worldHeight * 0.01;

  const scene = new Scene();
  scene.add(obj);
  const originals = new Map<Mesh, Material | Material[]>();
  obj.traverse((m) => {
    if ((m as Mesh).isMesh) originals.set(m as Mesh, (m as Mesh).material);
  });
  const asBasic = new Map<Material, Material>();
  const asNormal = new Map<Material, ShaderMaterial>();
  const conv = (mat: Material, kind: 'color' | 'normal') => {
    const s = mat as MeshStandardMaterial;
    const alphaTest = s.alphaTest > 0 ? s.alphaTest : s.transparent ? 0.5 : 0;
    if (kind === 'color') {
      if (!asBasic.has(mat)) asBasic.set(mat, new MeshBasicMaterial({ map: s.map, color: s.color, alphaTest, side: DoubleSide }));
      return asBasic.get(mat)!;
    }
    if (!asNormal.has(mat)) asNormal.set(mat, normalMat(s.map, alphaTest));
    return asNormal.get(mat)!;
  };

  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(o.width * o.frames, o.height);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NoToneMapping;
  renderer.setClearColor(0x000000, 0);
  renderer.setScissorTest(true);
  const cam = new OrthographicCamera(-worldWidth / 2, worldWidth / 2, worldHeight - base, -base, 0.1, radius * 4 + 10);

  const shoot = (kind: 'color' | 'normal') => {
    originals.forEach((orig, mesh) => {
      mesh.material = Array.isArray(orig) ? orig.map((m) => conv(m, kind)) : conv(orig, kind);
    });
    renderer.setScissor(0, 0, o.width * o.frames, o.height);
    renderer.setViewport(0, 0, o.width * o.frames, o.height);
    renderer.clear();
    for (let f = 0; f < o.frames; f++) {
      const az = (f / o.frames) * Math.PI * 2;
      const d = radius * 2 + 5;
      cam.position.set(Math.sin(az) * d, 0, Math.cos(az) * d);
      cam.lookAt(0, 0, 0);
      cam.updateMatrixWorld();
      if (kind === 'normal') {
        asNormal.forEach((m) => {
          m.uniforms.uNear.value = d - radius;
          m.uniforms.uFar.value = d + radius;
        });
      }
      renderer.setScissor(f * o.width, 0, o.width, o.height);
      renderer.setViewport(f * o.width, 0, o.width, o.height);
      renderer.render(scene, cam);
    }
    return canvas.toDataURL('image/png');
  };
  const color = shoot('color');
  const normal = shoot('normal');
  renderer.dispose();
  return { color, normal, worldWidth, worldHeight, base, frames: o.frames };
}

const w = window as unknown as { bake: typeof bake; bakeReady: boolean };
w.bake = bake;
w.bakeReady = true;
