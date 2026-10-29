import {
  ClampToEdgeWrapping, LinearMipmapLinearFilter, RepeatWrapping, SRGBColorSpace, TextureLoader, type Texture,
} from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

/** Base URL of the processed Poly Haven assets (see tools/process_assets.py). */
export const ASSETS = `${import.meta.env.BASE_URL}media/`;

const textures = new Map<string, Promise<Texture>>();
const models = new Map<string, Promise<GLTF>>();
const loader = new TextureLoader();
const gltf = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

/** Loads (once) a repeating, mipmapped texture. Colour maps are decoded from sRGB. */
export function loadTexture(path: string, srgb: boolean): Promise<Texture> {
  const key = `${path}|${srgb}`;
  let p = textures.get(key);
  if (!p) {
    p = loader.loadAsync(ASSETS + path).then((t) => {
      t.wrapS = t.wrapT = RepeatWrapping;
      t.minFilter = LinearMipmapLinearFilter;
      t.anisotropy = 8;
      if (srgb) t.colorSpace = SRGBColorSpace;
      return t;
    });
    textures.set(key, p);
  }
  return p;
}

export function loadModel(path: string): Promise<GLTF> {
  let p = models.get(path);
  if (!p) {
    p = gltf.loadAsync(ASSETS + path);
    models.set(path, p);
  }
  return p;
}

export interface GroundLayer {
  albedo: Texture;
  /** RG: tangent-space normal, B: roughness. */
  nrm: Texture;
  /** Metres covered by one repeat of the texture. */
  tile: number;
  /** Colour multiplier applied to the photographed albedo. */
  tint?: [number, number, number];
}

export async function loadGroundLayer(id: string, tile: number): Promise<GroundLayer> {
  const [albedo, nrm] = await Promise.all([loadTexture(`tex/${id}_albedo.jpg`, true), loadTexture(`tex/${id}_nrm.jpg`, false)]);
  return { albedo, nrm, tile };
}

export interface ImpostorAtlas {
  color: Texture;
  normal: Texture;
  frames: number;
  worldWidth: number;
  worldHeight: number;
  base: number;
}

let treeMeta: Promise<Record<string, Omit<ImpostorAtlas, 'color' | 'normal'>>> | null = null;

export async function loadImpostor(name: string): Promise<ImpostorAtlas> {
  treeMeta ??= fetch(`${ASSETS}trees/trees.json`).then((r) => r.json());
  const [meta, color, normal] = await Promise.all([
    treeMeta,
    loadTexture(`trees/${name}_color.webp`, true),
    loadTexture(`trees/${name}_normal.webp`, false),
  ]);
  for (const t of [color, normal]) t.wrapS = t.wrapT = ClampToEdgeWrapping;
  return { ...meta[name], color, normal };
}
