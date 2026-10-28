import { BufferGeometry, Float32BufferAttribute, Uint32BufferAttribute } from 'three';

/**
 * A ground grid fitted to a fixed camera looking down -Z from the origin.
 * Rows are spaced exponentially with distance and columns fan out with it, so
 * every cell covers a similar area on screen: a free LOD for a static view.
 */
export interface CameraGridOptions {
  cols: number;
  rows: number;
  near: number;
  far: number;
  /** tan of the half-angle covered horizontally. */
  halfWidth: number;
  /** Height function; defaults to flat. */
  height?: (x: number, z: number) => number;
}

export function createCameraGrid(o: CameraGridOptions): BufferGeometry {
  const { cols, rows, near, far, halfWidth } = o;
  const pos = new Float32Array(cols * rows * 3);
  const ratio = far / near;
  let k = 0;
  for (let r = 0; r < rows; r++) {
    const d = near * Math.pow(ratio, r / (rows - 1));
    for (let c = 0; c < cols; c++) {
      const u = c / (cols - 1);
      const x = (u - 0.5) * 2 * halfWidth * d;
      const z = -d;
      pos[k++] = x;
      pos[k++] = o.height ? o.height(x, z) : 0;
      pos[k++] = z;
    }
  }
  const idx = new Uint32Array((cols - 1) * (rows - 1) * 6);
  k = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      idx[k++] = a; idx[k++] = b; idx[k++] = d;
      idx[k++] = b; idx[k++] = e; idx[k++] = d;
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setIndex(new Uint32BufferAttribute(idx, 1));
  return geo;
}
