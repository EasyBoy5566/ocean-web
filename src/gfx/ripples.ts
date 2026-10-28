import {
  HalfFloatType, LinearFilter, ShaderMaterial, Vector2, Vector4, WebGLRenderTarget, ClampToEdgeWrapping,
  type Texture, type WebGLRenderer,
} from 'three';
import { FullscreenPass, FULLSCREEN_VERT } from './fullscreen';

export const MAX_DROPS = 12;

export interface SimDomain {
  /** Nearest distance (m) in front of the camera covered by the simulation. */
  near: number;
  /** Farthest distance (m). */
  far: number;
  /** tan of the half-angle covered horizontally. */
  halfWidth: number;
}

/**
 * Interactive ripples: a damped wave equation integrated on the GPU.
 *
 * The grid is warped like the camera's view (log-spaced rows, columns fanning
 * out with distance) so texels stay roughly constant in size on screen: a few
 * centimetres next to the viewer, about a metre a hundred metres out. Width and
 * height are chosen so texels are square in world space, keeping rings round.
 *
 * State texture: R = height now, G = previous height, B = foam.
 */
export class RippleSim {
  readonly width: number;
  readonly height: number;
  /** x: near, y: ln(far/near), z: halfWidth, w: enabled */
  readonly map: Vector4;
  private targets: [WebGLRenderTarget, WebGLRenderTarget];
  private current = 0;
  private pass = new FullscreenPass();
  private material: ShaderMaterial;
  private drops: Vector4[] = [];
  private pending: Vector4[] = [];
  private accumulator = 0;
  private static STEP = 1 / 60;

  constructor(domain: SimDomain, rows: number, flow: { tex: Texture | null; bounds: Vector4; flowMax: number }) {
    const A = Math.log(domain.far / domain.near);
    this.height = rows;
    this.width = Math.max(32, Math.round((rows * 2 * domain.halfWidth) / A));
    this.map = new Vector4(domain.near, A, domain.halfWidth, 1);
    const opts = {
      type: HalfFloatType,
      magFilter: LinearFilter,
      minFilter: LinearFilter,
      wrapS: ClampToEdgeWrapping,
      wrapT: ClampToEdgeWrapping,
      depthBuffer: false,
      generateMipmaps: false,
    } as const;
    this.targets = [new WebGLRenderTarget(this.width, this.height, opts), new WebGLRenderTarget(this.width, this.height, opts)];
    for (let i = 0; i < MAX_DROPS; i++) this.drops.push(new Vector4());
    this.material = new ShaderMaterial({
      uniforms: {
        uState: { value: null },
        uTexel: { value: new Vector2(1 / this.width, 1 / this.height) },
        uMap: { value: this.map },
        uSize: { value: new Vector2(this.width, this.height) },
        uDt: { value: RippleSim.STEP },
        uDrops: { value: this.drops },
        uDropCount: { value: 0 },
        uFlowTex: { value: flow.tex },
        uFlowBounds: { value: flow.bounds },
        uFlowMax: { value: flow.flowMax },
        uFlowOn: { value: flow.tex ? 1 : 0 },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D uState;
        uniform vec2 uTexel;
        uniform vec4 uMap;
        uniform vec2 uSize;
        uniform float uDt;
        uniform vec4 uDrops[${MAX_DROPS}];
        uniform int uDropCount;
        uniform sampler2D uFlowTex;
        uniform vec4 uFlowBounds;
        uniform float uFlowMax;
        uniform float uFlowOn;
        varying vec2 vUv;

        vec2 toWorld(vec2 uv) {
          float d = uMap.x * exp(uMap.y * uv.y);
          return vec2((uv.x - 0.5) * 2.0 * uMap.z * d, -d);
        }
        vec2 toUv(vec2 p) {
          float d = max(-p.y, 1e-3);
          return vec2(p.x / (2.0 * uMap.z * d) + 0.5, log(d / uMap.x) / uMap.y);
        }

        void main() {
          vec2 uv = vUv;
          vec2 wp = toWorld(uv);
          float d = -wp.y;
          float s = 2.0 * uMap.z * d / uSize.x;
          vec2 src = uv;
          if (uFlowOn > 0.5) {
            vec2 fuv = (wp - uFlowBounds.xy) / uFlowBounds.zw;
            vec2 flow = (texture2D(uFlowTex, fuv).gb * 2.0 - 1.0) * uFlowMax;
            src = toUv(wp - flow * uDt);
          }
          vec4 c = texture2D(uState, src);
          float h = c.r;
          float hp = c.g;
          float hl = texture2D(uState, src - vec2(uTexel.x, 0.0)).r;
          float hr = texture2D(uState, src + vec2(uTexel.x, 0.0)).r;
          float hd = texture2D(uState, src - vec2(0.0, uTexel.y)).r;
          float hu = texture2D(uState, src + vec2(0.0, uTexel.y)).r;
          // Bigger disturbances travel faster (gravity waves); tiny ones near the capillary minimum.
          float speed = 0.3 + 0.55 * s;
          float k = min(pow(speed * uDt / s, 2.0), 0.45);
          float damp = 0.993;
          float hn = h + (h - hp) * damp + k * (hl + hr + hd + hu - 4.0 * h);
          hn *= 0.9993;
          float foam = c.b * 0.985;
          for (int i = 0; i < ${MAX_DROPS}; i++) {
            if (i >= uDropCount) break;
            vec4 dp = uDrops[i];
            float r = max(dp.z, s * 1.6);
            vec2 dv = wp - dp.xy;
            float g = exp(-dot(dv, dv) / (r * r));
            hn -= dp.w * g;
            foam += g * min(abs(dp.w) * 40.0, 1.0);
          }
          float edge = smoothstep(0.0, 0.04, uv.x) * smoothstep(1.0, 0.96, uv.x) * smoothstep(1.0, 0.94, uv.y) * smoothstep(0.0, 0.02, uv.y);
          hn *= mix(0.9, 1.0, edge);
          gl_FragColor = vec4(hn, h, min(foam, 1.5), 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
  }

  get texture(): Texture {
    return this.targets[this.current].texture;
  }

  /** Is this world point covered by the simulation? */
  covers(x: number, z: number): boolean {
    const d = -z;
    if (d < this.map.x) return false;
    const u = x / (2 * this.map.z * d) + 0.5;
    const v = Math.log(d / this.map.x) / this.map.y;
    return u > 0.02 && u < 0.98 && v < 0.97;
  }

  /** Push the surface down by `strength` metres in a Gaussian of `radius` metres. */
  addDrop(x: number, z: number, radius: number, strength: number) {
    if (this.pending.length >= MAX_DROPS) this.pending.shift();
    this.pending.push(new Vector4(x, z, radius, strength));
  }

  update(renderer: WebGLRenderer, dt: number) {
    this.accumulator = Math.min(this.accumulator + dt, RippleSim.STEP * 3);
    while (this.accumulator >= RippleSim.STEP) {
      this.accumulator -= RippleSim.STEP;
      const u = this.material.uniforms;
      const n = this.pending.length;
      for (let i = 0; i < n; i++) this.drops[i].copy(this.pending[i]);
      u.uDropCount.value = n;
      this.pending.length = 0;
      u.uState.value = this.targets[this.current].texture;
      const next = 1 - this.current;
      this.pass.render(renderer, this.material, this.targets[next]);
      this.current = next;
    }
  }

  clear(renderer: WebGLRenderer) {
    const prev = renderer.getRenderTarget();
    for (const t of this.targets) {
      renderer.setRenderTarget(t);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
    }
    renderer.setRenderTarget(prev);
  }

  dispose() {
    this.targets.forEach((t) => t.dispose());
    this.material.dispose();
    this.pass.dispose();
  }
}
