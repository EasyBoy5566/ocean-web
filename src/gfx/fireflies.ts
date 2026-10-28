import { AdditiveBlending, BufferGeometry, Float32BufferAttribute, Points, ShaderMaterial } from 'three';
import { mulberry32 } from '../util/math';
import { LAYER_REFLECTED, LAYER_SURFACE } from './composite';
import { GLOBALS, OUTPUT } from './glsl';
import { globals } from './globals';

/** Blinking fireflies drifting over the riverbanks on warm nights. */
export class Fireflies {
  readonly points: Points;
  private material: ShaderMaterial;

  constructor(count: number, place: (rnd: () => number) => [number, number, number]) {
    const rnd = mulberry32(17);
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      pos.set(place(rnd), i * 3);
      seed.set([rnd() * 100, 0.6 + rnd() * 0.9, rnd() * 6.28, rnd()], i * 4);
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new Float32BufferAttribute(seed, 4));
    this.material = new ShaderMaterial({
      uniforms: { ...globals, uVis: { value: 0 }, uScale: { value: 800 } },
      vertexShader: /* glsl */ `
        attribute vec4 aSeed;
        uniform float uTime;
        uniform float uScale;
        varying float vGlow;
        void main() {
          float t = uTime * 0.25 + aSeed.x;
          vec3 p = position + vec3(sin(t * 1.3) * 1.6 + sin(t * 2.9) * 0.4, sin(t * 1.7 + aSeed.z) * 0.5, cos(t * 1.1) * 1.6);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          // brief flashes with long dark gaps, each insect on its own rhythm
          float ph = fract(uTime * aSeed.y * 0.22 + aSeed.w);
          vGlow = smoothstep(0.0, 0.08, ph) * (1.0 - smoothstep(0.1, 0.32, ph));
          gl_PointSize = max(0.16 * uScale / max(-mv.z, 0.1), 2.5);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        ${GLOBALS}
        uniform float uVis;
        varying float vGlow;
        void main() {
          vec2 c = gl_PointCoord * 2.0 - 1.0;
          float r = dot(c, c);
          if (r > 1.0) discard;
          float core = exp(-r * 9.0) + 0.25 * exp(-r * 2.5);
          vec3 col = vec3(0.7, 1.0, 0.3) * core * vGlow * uVis * 3.0 / uExposure;
          gl_FragColor = vec4(col, 1.0);
          ${OUTPUT}
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.points = new Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 30;
    // drawn over the water (they never write depth) and mirrored in it
    this.points.layers.set(LAYER_SURFACE);
    this.points.layers.enable(LAYER_REFLECTED);
  }

  update(night: number, pixelScale: number) {
    this.material.uniforms.uVis.value = Math.max(0, (night - 0.55) / 0.45);
    this.material.uniforms.uScale.value = pixelScale;
    this.points.visible = night > 0.55;
  }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
