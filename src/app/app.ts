import { ACESFilmicToneMapping, SRGBColorSpace, WebGLRenderer, type Texture } from 'three';
import { Environment } from '../env/environment';
import { resolveLocation, type GeoLocation } from '../env/location';
import { globals } from '../gfx/globals';
import { createNoiseTexture, createWaterNormalTexture } from '../gfx/textures';
import { LakeWorld } from '../world/lake';
import { OceanWorld } from '../world/ocean';
import { RiverWorld } from '../world/river';
import type { SceneId, SoundSink, World, WorldDeps } from '../world/world';
import { Gestures } from './gestures';
import { params } from './params';
import { detectTier, ResolutionGovernor, settingsFor, type Tier, type TierSettings } from './quality';

export const SCENES: SceneId[] = ['lake', 'ocean', 'river'];

const silentSound: SoundSink = { splash() {}, throwWhoosh() {} };

export interface AppEvents {
  onFrame?(app: App): void;
  onSceneChange?(id: SceneId): void;
  onLocation?(loc: GeoLocation): void;
  onActivity?(): void;
  onInteract?(kind: 'tap' | 'throw'): void;
}

/** Owns the renderer, the active world and the frame loop. */
export class App {
  readonly renderer: WebGLRenderer;
  readonly env = new Environment();
  readonly canvas: HTMLCanvasElement;
  tier: TierSettings;
  world: World | null = null;
  sceneId: SceneId = 'lake';
  sound: SoundSink = silentSound;
  events: AppEvents = {};
  fps = 0;
  private governor: ResolutionGovernor;
  private noiseTex: Texture;
  private waterNormalTex: Texture;
  private halfFloat: boolean;
  private last = performance.now();
  private elapsed = 0;
  private running = false;
  private frames = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;
  private switching = false;
  /** Worlds keep this forwarding sink, so the real one can be swapped in later (audio unlock). */
  private soundProxy: SoundSink = {
    splash: (kind, pos, energy) => this.sound.splash(kind, pos, energy),
    throwWhoosh: (power) => this.sound.throwWhoosh(power),
  };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', alpha: false });
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.outputColorSpace = SRGBColorSpace;
    const ext = this.renderer.extensions;
    this.halfFloat = ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float');
    this.tier = settingsFor(detectTier(this.renderer));
    this.governor = new ResolutionGovernor(this.tier);
    this.renderer.setPixelRatio(this.governor.dpr);
    this.noiseTex = createNoiseTexture();
    this.waterNormalTex = createWaterNormalTexture();
    globals.uNoiseTex.value = this.noiseTex;
    this.env.setCloudOctaves(this.tier.cloudOctaves);

    new Gestures(canvas, {
      tap: (x, y) => {
        if (this.world?.tap(x, y)) this.events.onInteract?.('tap');
      },
      flick: (up, side, sx) => {
        this.world?.throwStone(up, side, sx);
        this.events.onInteract?.('throw');
      },
      activity: () => this.events.onActivity?.(),
    });
    window.addEventListener('resize', () => this.resize());
    window.visualViewport?.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.stop();
      else this.start();
    });
  }

  async locate() {
    const loc = await resolveLocation();
    this.setLocation(loc);
  }

  setLocation(loc: GeoLocation) {
    this.env.location = loc;
    this.events.onLocation?.(loc);
  }

  private deps(): WorldDeps {
    return {
      renderer: this.renderer,
      env: this.env,
      tier: this.tier,
      noiseTex: this.noiseTex,
      waterNormalTex: this.waterNormalTex,
      halfFloat: this.halfFloat,
      sound: this.soundProxy,
    };
  }

  private createWorld(id: SceneId): World {
    const deps = this.deps();
    if (id === 'ocean') return new OceanWorld(deps);
    if (id === 'river') return new RiverWorld(deps);
    return new LakeWorld(deps);
  }

  /** Builds and activates a scene (disposing the previous one). */
  loadScene(id: SceneId) {
    const old = this.world;
    this.world = null;
    old?.dispose();
    const w = this.createWorld(id);
    w.build();
    w.activate();
    this.world = w;
    this.sceneId = id;
    this.resize();
    // Warm up: render one frame so shaders compile before the scene is shown.
    this.env.update(this.renderer, 0, this.elapsed);
    w.update(0);
    w.render(this.renderer);
    this.events.onSceneChange?.(id);
  }

  async switchScene(id: SceneId, fade: HTMLElement | null) {
    if (this.switching || id === this.sceneId) return;
    this.switching = true;
    if (fade) {
      fade.classList.add('on');
      await new Promise((r) => setTimeout(r, 450));
    }
    this.loadScene(id);
    if (fade) {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      fade.classList.remove('on');
    }
    this.switching = false;
  }

  setTier(t: Tier) {
    this.tier = settingsFor(t);
    this.governor = new ResolutionGovernor(this.tier);
    this.renderer.setPixelRatio(this.governor.dpr);
    this.env.setCloudOctaves(this.tier.cloudOctaves);
    const id = this.sceneId;
    this.sceneId = '' as SceneId;
    this.loadScene(id);
  }

  setSound(s: SoundSink) {
    this.sound = s;
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, true);
    const dw = this.renderer.domElement.width;
    const dh = this.renderer.domElement.height;
    this.world?.resize(w, h, dw, dh);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(this.frame);
  }

  stop() {
    this.running = false;
  }

  private frame = (now: number) => {
    if (!this.running) return;
    requestAnimationFrame(this.frame);
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    this.elapsed += dt;
    const w = this.world;
    if (!w) return;
    this.env.update(this.renderer, dt, this.elapsed);
    w.update(dt);
    w.render(this.renderer);
    this.frames++;
    this.fpsAcc += dt;
    this.fpsFrames++;
    if (this.fpsAcc >= 0.5) {
      this.fps = this.fpsFrames / this.fpsAcc;
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }
    if (!params.shot && this.governor.sample(dt)) {
      this.renderer.setPixelRatio(this.governor.dpr);
      this.resize();
    }
    if (this.frames === 30) (window as unknown as { __ready: boolean }).__ready = true;
    this.events.onFrame?.(this);
  };

  get pixelRatio() {
    return this.governor.dpr;
  }
}
