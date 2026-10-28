import {
  HalfFloatType, LinearFilter, Matrix4, PerspectiveCamera, Plane, UnsignedByteType, Vector3, Vector4,
  WebGLRenderTarget, type Camera, type Object3D, type Scene, type WebGLRenderer,
} from 'three';
import { globals } from './globals';

const normal = new Vector3(0, 1, 0);
const planePoint = new Vector3();
const camPos = new Vector3();
const lookAt = new Vector3();
const target = new Vector3();
const view = new Vector3();
const rot = new Matrix4();
const plane = new Plane();
const clip = new Vector4();
const q = new Vector4();

/**
 * Mirror image of the scene across a horizontal water plane, rendered from a
 * virtual camera with an oblique near plane so nothing under water leaks in.
 * Based on three.js' Reflector, specialised for a y-up plane.
 */
export class PlanarReflection {
  readonly target: WebGLRenderTarget;
  readonly textureMatrix = new Matrix4();
  readonly camera = new PerspectiveCamera();
  scale: number;

  constructor(scale: number, halfFloat: boolean) {
    this.scale = scale;
    this.target = new WebGLRenderTarget(4, 4, {
      type: halfFloat ? HalfFloatType : UnsignedByteType,
      magFilter: LinearFilter,
      minFilter: LinearFilter,
      generateMipmaps: false,
    });
  }

  setSize(width: number, height: number) {
    const w = Math.max(4, Math.round(width * this.scale));
    const h = Math.max(4, Math.round(height * this.scale));
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);
  }

  render(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera, planeY: number, hidden: Object3D[]) {
    planePoint.set(0, planeY, 0);
    camPos.setFromMatrixPosition(camera.matrixWorld);
    if (camPos.y <= planeY) return;

    view.subVectors(planePoint, camPos).reflect(normal).negate().add(planePoint);
    rot.extractRotation(camera.matrixWorld);
    lookAt.set(0, 0, -1).applyMatrix4(rot).add(camPos);
    target.subVectors(planePoint, lookAt).reflect(normal).negate().add(planePoint);

    const vc = this.camera;
    vc.position.copy(view);
    vc.up.set(0, 1, 0).applyMatrix4(rot).reflect(normal);
    vc.lookAt(target);
    vc.near = camera.near;
    vc.far = camera.far;
    vc.updateMatrixWorld();
    vc.projectionMatrix.copy(camera.projectionMatrix);
    vc.projectionMatrixInverse.copy(camera.projectionMatrixInverse);

    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.textureMatrix.multiply(vc.projectionMatrix).multiply(vc.matrixWorldInverse);

    // Oblique near plane = water plane (Lengyel).
    plane.setFromNormalAndCoplanarPoint(normal, planePoint).applyMatrix4(vc.matrixWorldInverse);
    clip.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const e = vc.projectionMatrix.elements;
    q.x = (Math.sign(clip.x) + e[8]) / e[0];
    q.y = (Math.sign(clip.y) + e[9]) / e[5];
    q.z = -1;
    q.w = (1 + e[10]) / e[14];
    clip.multiplyScalar(2 / clip.dot(q));
    e[2] = clip.x;
    e[6] = clip.y;
    e[10] = clip.z + 1 - 0.003;
    e[14] = clip.w;

    const vis = hidden.map((o) => o.visible);
    hidden.forEach((o) => (o.visible = false));
    globals.uReflectionPass.value = 1;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(scene, vc as Camera as PerspectiveCamera);
    renderer.setRenderTarget(prev);
    globals.uReflectionPass.value = 0;
    hidden.forEach((o, i) => (o.visible = vis[i]));
  }

  dispose() {
    this.target.dispose();
  }
}
