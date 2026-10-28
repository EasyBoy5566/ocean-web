import { Vector3, type Camera } from 'three';
import type { SceneId, SoundSink } from '../world/world';

/**
 * Soundscape built from real CC0 field recordings (see public/audio/CREDITS.md):
 * a looping bed per scene, wildlife layers that follow the sun, and recorded
 * splashes placed in stereo by where they happen. Recordings load lazily; until
 * one arrives, interaction sounds fall back to small synthesised versions.
 */

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

type Clip = 'ocean' | 'lake' | 'river' | 'birds' | 'gulls' | 'crickets' | 'frogs' | 'plop1' | 'plop2' | 'plop3' | 'tap' | 'splash' | 'skip';

const BED: Record<SceneId, { clip: Clip; level: number }> = {
  ocean: { clip: 'ocean', level: 0.95 },
  lake: { clip: 'lake', level: 0.75 },
  river: { clip: 'river', level: 0.9 },
};

/** Wildlife layers per scene: which recording, and how loud by day / by night. */
const LIFE: Record<SceneId, { clip: Clip; day: number; night: number; dawn: number }[]> = {
  ocean: [
    { clip: 'gulls', day: 0.28, night: 0, dawn: 0.1 },
    { clip: 'crickets', day: 0, night: 0.35, dawn: 0 },
  ],
  lake: [
    { clip: 'birds', day: 0.55, night: 0, dawn: 0.6 },
    { clip: 'crickets', day: 0, night: 0.55, dawn: 0 },
    { clip: 'frogs', day: 0, night: 0.45, dawn: 0 },
  ],
  river: [
    { clip: 'birds', day: 0.5, night: 0, dawn: 0.5 },
    { clip: 'crickets', day: 0, night: 0.45, dawn: 0 },
    { clip: 'frogs', day: 0, night: 0.35, dawn: 0 },
  ],
};

class Library {
  private ctx: AudioContext;
  private cache = new Map<Clip, Promise<AudioBuffer | null>>();
  private ready = new Map<Clip, AudioBuffer>();
  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }
  load(name: Clip): Promise<AudioBuffer | null> {
    let p = this.cache.get(name);
    if (!p) {
      p = fetch(`${import.meta.env.BASE_URL}audio/${name}.mp3`)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.statusText))))
        .then((b) => this.ctx.decodeAudioData(b))
        .then((buf) => {
          this.ready.set(name, buf);
          return buf;
        })
        .catch((e) => {
          console.warn(`audio ${name} unavailable`, e);
          return null;
        });
      this.cache.set(name, p);
    }
    return p;
  }
  get(name: Clip): AudioBuffer | undefined {
    return this.ready.get(name);
  }
}

/**
 * Endless playback of a recording: consecutive copies overlap and crossfade
 * over several seconds, so there is no audible loop point.
 */
class Loop {
  readonly gain: GainNode;
  private next = 0;
  private sources: AudioBufferSourceNode[] = [];
  private stopped = false;
  private static XFADE = 4;

  constructor(private ctx: AudioContext, private buffer: AudioBuffer, out: AudioNode) {
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(out);
    this.next = ctx.currentTime + 0.05;
    this.schedule(true);
  }

  private schedule(first = false) {
    const ctx = this.ctx;
    const X = Loop.XFADE;
    const dur = this.buffer.duration - 0.4;
    const offset = first ? rand(0, dur * 0.6) : 0.2;
    const length = dur - offset + 0.2;
    const t = this.next;
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    const g = ctx.createGain();
    g.gain.setValueAtTime(first ? 1 : 0, t);
    if (!first) g.gain.linearRampToValueAtTime(1, t + X);
    g.gain.setValueAtTime(1, t + length - X);
    g.gain.linearRampToValueAtTime(0, t + length);
    src.connect(g).connect(this.gain);
    src.start(t, offset);
    src.stop(t + length + 0.05);
    src.onended = () => {
      this.sources = this.sources.filter((s) => s !== src);
      g.disconnect();
    };
    this.sources.push(src);
    this.next = t + length - X;
  }

  update(now: number) {
    if (!this.stopped && this.next - now < 1.5) this.schedule();
  }

  stop(at: number) {
    this.stopped = true;
    this.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.4);
    this.sources.forEach((s) => s.stop(at));
    setTimeout(() => this.gain.disconnect(), Math.max(0, (at - this.ctx.currentTime) * 1000) + 500);
  }
}

function noiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function panner(ctx: AudioContext, pan: number, dest: AudioNode) {
  const p = ctx.createStereoPanner();
  p.pan.value = Math.max(-1, Math.min(1, pan));
  p.connect(dest);
  return p;
}

export class AudioEngine implements SoundSink {
  readonly ctx: AudioContext;
  private master: GainNode;
  private sfx: GainNode;
  private ambience: GainNode;
  private lib: Library;
  private noise: AudioBuffer;
  private scene: SceneId | null = null;
  private bed: Loop | null = null;
  private life: { loop: Loop; spec: (typeof LIFE)[SceneId][number] }[] = [];
  private camera: Camera | null = null;
  private muted = false;
  private tmp = new Vector3();
  private lastSkip = 0;

  constructor() {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor({ latencyHint: 'interactive' });
    const ctx = this.ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 3;
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(comp);
    this.ambience = ctx.createGain();
    this.ambience.gain.value = 1;
    this.ambience.connect(this.master);
    this.sfx = ctx.createGain();
    this.sfx.gain.value = 1;
    this.sfx.connect(this.master);
    this.lib = new Library(ctx);
    this.noise = noiseBuffer(ctx, 1);
    for (const c of ['plop1', 'plop2', 'plop3', 'tap', 'skip', 'splash'] as Clip[]) void this.lib.load(c);
  }

  /** Must be called from a user gesture (tap/click) for browsers to allow sound. */
  async unlock() {
    const nav = navigator as Navigator & { audioSession?: { type: string } };
    // Play through the iPhone ring/silent switch once the user has touched the page.
    if (nav.audioSession) nav.audioSession.type = 'playback';
    const b = this.ctx.createBuffer(1, 1, 22050);
    const s = this.ctx.createBufferSource();
    s.buffer = b;
    s.connect(this.ctx.destination);
    s.start(0);
    await this.ctx.resume();
    this.setMuted(this.muted);
  }

  setMuted(m: boolean) {
    this.muted = m;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(m ? 0 : 1, now, 0.25);
  }

  get isMuted() {
    return this.muted;
  }

  suspend() {
    void this.ctx.suspend();
  }

  resume() {
    void this.ctx.resume();
  }

  setScene(id: SceneId) {
    if (this.scene === id) return;
    this.scene = id;
    const at = this.ctx.currentTime + 2;
    this.bed?.stop(at);
    this.life.forEach((l) => l.loop.stop(at));
    this.bed = null;
    this.life = [];
    const bed = BED[id];
    void this.lib.load(bed.clip).then((buf) => {
      if (!buf || this.scene !== id) return;
      this.bed = new Loop(this.ctx, buf, this.ambience);
      this.bed.gain.gain.setTargetAtTime(bed.level, this.ctx.currentTime, 0.8);
    });
    for (const spec of LIFE[id]) {
      void this.lib.load(spec.clip).then((buf) => {
        if (!buf || this.scene !== id) return;
        this.life.push({ loop: new Loop(this.ctx, buf, this.ambience), spec });
      });
    }
  }

  update(camera: Camera, night: number, sunAltDeg: number, morning: boolean) {
    this.camera = camera;
    if (this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    const day = 1 - night;
    const dawn = morning ? Math.max(0, 1 - Math.abs(sunAltDeg - 4) / 10) : 0;
    this.bed?.update(now);
    for (const { loop, spec } of this.life) {
      loop.update(now);
      const level = spec.day * day + spec.night * night + spec.dawn * dawn;
      loop.gain.gain.setTargetAtTime(level, now, 1.2);
    }
  }

  /** Gain and stereo position for a sound at a world position. */
  private place(pos: Vector3): { gain: number; pan: number } {
    if (!this.camera) return { gain: 1, pan: 0 };
    const local = this.tmp.copy(pos).applyMatrix4(this.camera.matrixWorldInverse);
    const dist = local.length();
    return { gain: 1 / (1 + dist / 8), pan: Math.max(-0.9, Math.min(0.9, local.x / (Math.abs(local.z) + 3))) };
  }

  private play(clip: Clip, out: AudioNode, t: number, gain: number, rate: number): boolean {
    const buf = this.lib.get(clip);
    if (!buf) return false;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(out);
    src.start(t);
    src.onended = () => g.disconnect();
    return true;
  }

  /** Synthesised stand-in: filtered noise burst plus a resonant 'bloop'. */
  private synth(out: AudioNode, t: number, dur: number, freq: number, vol: number, bloop = 0) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    src.connect(f).connect(g).connect(out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
    if (bloop > 0) {
      const o = ctx.createOscillator();
      const og = ctx.createGain();
      o.frequency.setValueAtTime(bloop, t);
      o.frequency.exponentialRampToValueAtTime(bloop * 2.4, t + 0.08);
      og.gain.setValueAtTime(vol * 0.8, t);
      og.gain.exponentialRampToValueAtTime(0.0005, t + 0.14);
      o.connect(og).connect(out);
      o.start(t);
      o.stop(t + 0.16);
    }
  }

  splash(kind: 'tap' | 'plunge' | 'skip' | 'land', pos: Vector3, energy: number) {
    const ctx = this.ctx;
    if (ctx.state !== 'running' || this.muted) return;
    const t = ctx.currentTime + 0.005;
    const { gain, pan } = this.place(pos);
    const out = panner(ctx, pan, this.sfx);
    setTimeout(() => out.disconnect(), 3000);
    if (kind === 'tap') {
      if (!this.play('tap', out, t, 0.9 * gain, rand(0.85, 1.2))) this.synth(out, t, 0.12, 2300, 0.4 * gain, 700);
    } else if (kind === 'plunge') {
      // heavier, faster stones sound deeper and fuller
      const rate = rand(0.92, 1.08) * (1.12 - energy * 0.25);
      if (!this.play(pick(['plop1', 'plop2', 'plop3'] as Clip[]), out, t, (0.75 + 0.5 * energy) * gain, rate)) {
        this.synth(out, t, 0.3, 1500, 0.5 * gain, 280);
      }
      if (energy > 0.55) this.play('splash', out, t, (energy - 0.45) * 0.6 * gain, rand(1.1, 1.3));
    } else if (kind === 'skip') {
      if (t - this.lastSkip < 0.05) return;
      this.lastSkip = t;
      if (!this.play('skip', out, t, (0.4 + 0.5 * energy) * gain, rand(1.3, 1.7))) this.synth(out, t, 0.05, 3200, 0.35 * gain);
    } else {
      // stone clacking on rock or wood
      this.synth(out, t, 0.035, 3400, 0.4 * gain);
      const k = ctx.createOscillator();
      const kg = ctx.createGain();
      k.frequency.setValueAtTime(330, t);
      k.frequency.exponentialRampToValueAtTime(190, t + 0.05);
      kg.gain.setValueAtTime(0.2 * gain, t);
      kg.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
      k.connect(kg).connect(out);
      k.start(t);
      k.stop(t + 0.08);
    }
  }

  throwWhoosh(power: number) {
    const ctx = this.ctx;
    if (ctx.state !== 'running' || this.muted) return;
    const t = ctx.currentTime + 0.005;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.2;
    f.frequency.setValueAtTime(500, t);
    f.frequency.exponentialRampToValueAtTime(1800 + power * 1500, t + 0.22);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.04 + power * 0.07, t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.28);
    src.connect(f).connect(g).connect(panner(ctx, 0.35, this.sfx));
    src.start(t);
    src.stop(t + 0.3);
  }
}
