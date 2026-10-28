import type { WebGLRenderer } from 'three';
import { params } from './params';

export type Tier = 'low' | 'medium' | 'high';

export interface TierSettings {
  tier: Tier;
  dprStart: number;
  dprMin: number;
  dprMax: number;
  reflectionScale: number;
  simRows: number;
  cloudOctaves: number;
  vegetation: number;
  terrain: { cols: number; rows: number };
  water: { cols: number; rows: number };
}

export const TIERS: Record<Tier, Omit<TierSettings, 'tier'>> = {
  high: {
    dprStart: 2, dprMin: 1, dprMax: 2, reflectionScale: 0.5, simRows: 384, cloudOctaves: 5, vegetation: 1,
    terrain: { cols: 256, rows: 230 }, water: { cols: 160, rows: 200 },
  },
  medium: {
    dprStart: 1.5, dprMin: 1, dprMax: 2, reflectionScale: 0.42, simRows: 320, cloudOctaves: 4, vegetation: 0.7,
    terrain: { cols: 200, rows: 190 }, water: { cols: 128, rows: 170 },
  },
  low: {
    dprStart: 1, dprMin: 0.75, dprMax: 1.25, reflectionScale: 0.33, simRows: 224, cloudOctaves: 3, vegetation: 0.45,
    terrain: { cols: 150, rows: 150 }, water: { cols: 100, rows: 130 },
  },
};

export const isMobile = (() => {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod|Android|Mobile/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
})();

const STORAGE_KEY = 'waterscape.quality';

export function storedTierChoice(): Tier | 'auto' {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'low' || v === 'medium' || v === 'high') return v;
  } catch {
    /* ignore */
  }
  return 'auto';
}

export function storeTierChoice(v: Tier | 'auto') {
  try {
    localStorage.setItem(STORAGE_KEY, v);
  } catch {
    /* ignore */
  }
}

export function detectTier(renderer: WebGLRenderer): Tier {
  if (params.quality) return params.quality;
  const choice = storedTierChoice();
  if (choice !== 'auto') return choice;
  const gl = renderer.getContext();
  let gpu = '';
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) gpu = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
  } catch {
    /* masked */
  }
  if (/swiftshader|llvmpipe|software/i.test(gpu)) return 'low';
  const cores = navigator.hardwareConcurrency || 4;
  if (isMobile) return cores <= 4 ? 'low' : 'medium';
  if (/Intel/i.test(gpu) && !/Arc|Iris Xe/i.test(gpu)) return 'medium';
  return 'high';
}

export function settingsFor(tier: Tier): TierSettings {
  const s = TIERS[tier];
  const dpr = window.devicePixelRatio || 1;
  return {
    tier,
    ...s,
    dprStart: Math.min(s.dprStart, dpr),
    dprMax: Math.min(s.dprMax, dpr),
    dprMin: Math.min(s.dprMin, dpr),
  };
}

/**
 * Keeps the frame rate up by trading render resolution: drops the pixel ratio
 * when frames are slow, raises it again after a sustained run of fast frames.
 */
export class ResolutionGovernor {
  dpr: number;
  private settings: TierSettings;
  private acc = 0;
  private frames = 0;
  private fastStreak = 0;
  private cooldown = 2;

  constructor(settings: TierSettings) {
    this.settings = settings;
    this.dpr = settings.dprStart;
  }

  /** Returns true when the pixel ratio changed. */
  sample(dt: number): boolean {
    if (this.cooldown > 0) {
      this.cooldown -= dt;
      return false;
    }
    this.acc += dt;
    this.frames++;
    if (this.acc < 1) return false;
    const avg = this.acc / this.frames;
    this.acc = 0;
    this.frames = 0;
    const s = this.settings;
    if (avg > 1 / 50 && this.dpr > s.dprMin) {
      this.dpr = Math.max(s.dprMin, this.dpr * 0.85);
      this.fastStreak = 0;
      this.cooldown = 1.5;
      return true;
    }
    if (avg < 1 / 58) {
      this.fastStreak++;
      if (this.fastStreak >= 4 && this.dpr < s.dprMax) {
        this.dpr = Math.min(s.dprMax, this.dpr * 1.1);
        this.fastStreak = 0;
        this.cooldown = 1.5;
        return true;
      }
    } else {
      this.fastStreak = 0;
    }
    return false;
  }
}
