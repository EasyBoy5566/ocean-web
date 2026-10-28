import {
  AlwaysDepth, DepthTexture, HalfFloatType, LinearFilter, NearestFilter, ShaderMaterial, UnsignedByteType,
  UnsignedIntType, WebGLRenderTarget, type WebGLRenderer,
} from 'three';
import { FullscreenPass, FULLSCREEN_VERT } from './fullscreen';
import { OUTPUT } from './glsl';

/** Layers: 0 = scene behind/under the water, 1 = water and spray, 2 = also seen in reflections. */
export const LAYER_SCENE = 0;
export const LAYER_SURFACE = 1;
export const LAYER_REFLECTED = 2;

/**
 * Everything except the water surface is rendered into this target first, so
 * the water can refract it (bend what is seen through ripples and waves). The
 * composite pass then copies colour and depth to the screen before the water
 * is drawn on top.
 */
export class SceneTarget {
  readonly target: WebGLRenderTarget;
  private pass = new FullscreenPass();
  private material: ShaderMaterial;

  constructor(halfFloat: boolean, samples: number) {
    this.target = new WebGLRenderTarget(4, 4, {
      type: halfFloat ? HalfFloatType : UnsignedByteType,
      magFilter: LinearFilter,
      minFilter: LinearFilter,
      generateMipmaps: false,
      samples,
      depthTexture: new DepthTexture(4, 4, UnsignedIntType),
    });
    const depth = this.target.depthTexture!;
    depth.magFilter = depth.minFilter = NearestFilter;
    this.material = new ShaderMaterial({
      uniforms: { uColor: { value: this.target.texture }, uDepth: { value: depth } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D uColor;
        uniform sampler2D uDepth;
        varying vec2 vUv;
        void main() {
          gl_FragColor = vec4(texture2D(uColor, vUv).rgb, 1.0);
          gl_FragDepth = texture2D(uDepth, vUv).r;
          ${OUTPUT}
        }
      `,
      depthTest: true,
      depthWrite: true,
      depthFunc: AlwaysDepth,
    });
  }

  get color() {
    return this.target.texture;
  }

  get depth() {
    return this.target.depthTexture!;
  }

  setSize(w: number, h: number) {
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);
  }

  /** Draws the captured scene (tone mapped) and its depth into the current framebuffer. */
  composite(renderer: WebGLRenderer) {
    this.pass.render(renderer, this.material, renderer.getRenderTarget());
  }

  dispose() {
    this.target.depthTexture?.dispose();
    this.target.dispose();
    this.material.dispose();
    this.pass.dispose();
  }
}
