import {
  BufferGeometry, Float32BufferAttribute, Mesh, OrthographicCamera, Scene, type Material,
  type WebGLRenderer, type WebGLRenderTarget,
} from 'three';

/** Renders a single full-screen triangle with a given material into a target. */
export class FullscreenPass {
  private scene = new Scene();
  private camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mesh: Mesh;

  constructor(material?: Material) {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geo.setAttribute('uv', new Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.mesh = new Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  render(renderer: WebGLRenderer, material: Material, target: WebGLRenderTarget | null) {
    this.mesh.material = material;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(prev);
  }

  dispose() {
    this.mesh.geometry.dispose();
  }
}

export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
