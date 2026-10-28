import { ClampToEdgeWrapping, DataTexture, LinearFilter, RGBAFormat, UnsignedByteType, Vector4 } from 'three';

export interface WaterDataSource {
  /** World rectangle covered: minX, minZ, sizeX, sizeZ. */
  bounds: Vector4;
  width: number;
  height: number;
  depthMax: number;
  flowMax: number;
  terrainHeight: (x: number, z: number) => number;
  flow?: (x: number, z: number) => [number, number];
  foam?: (x: number, z: number) => number;
}

/**
 * Bakes per-scene water facts into a texture the water shader can read:
 * R = depth / depthMax, GB = flow velocity (m/s, signed), A = obstacle foam.
 */
export function bakeWaterData(src: WaterDataSource): DataTexture {
  const { width, height, bounds } = src;
  const data = new Uint8Array(width * height * 4);
  for (let j = 0; j < height; j++) {
    const z = bounds.y + ((j + 0.5) / height) * bounds.w;
    for (let i = 0; i < width; i++) {
      const x = bounds.x + ((i + 0.5) / width) * bounds.z;
      const k = (j * width + i) * 4;
      const depth = Math.max(0, -src.terrainHeight(x, z));
      data[k] = Math.round(Math.min(depth / src.depthMax, 1) * 255);
      const f = src.flow ? src.flow(x, z) : [0, 0];
      data[k + 1] = Math.round((Math.max(-1, Math.min(1, f[0] / src.flowMax)) * 0.5 + 0.5) * 255);
      data[k + 2] = Math.round((Math.max(-1, Math.min(1, f[1] / src.flowMax)) * 0.5 + 0.5) * 255);
      data[k + 3] = Math.round(Math.min(1, Math.max(0, src.foam ? src.foam(x, z) : 0)) * 255);
    }
  }
  const tex = new DataTexture(data, width, height, RGBAFormat, UnsignedByteType);
  tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
  tex.magFilter = tex.minFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
