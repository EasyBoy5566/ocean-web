import { Vector3, type Camera } from 'three';
import type { SceneId, SoundSink } from '../world/world';

/**
 * Procedural soundscape: every sound is synthesised with Web Audio (filtered
 * noise, short oscillator chirps), so nothing has to be downloaded and nothing
 * loops audibly. Ambient beds follow the scene, wildlife follows the sun, and
 * interaction sounds are panned and attenuated by where they happen.
 */

const rand = (a: number, b: number) => a + Math.random() * (b - a);

function noiseBuffer(ctx: AudioContext, seconds: number, kind: 'white' | 'pink' | 'brown'): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (kind === 'white') d[i] = w;
    else if (kind === 'pink') {
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    } else {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
  }
  // Crossfade the ends so the loop point is inaudible.
  const fade = Math.floor(ctx.sampleRate * 0.05);
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    d[len - fade + i] = d[len - fade + i] * (1 - t) + d[i] * t;
  }
  return buf;
}

function impulse(ctx: AudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      lp = lp * 0.6 + (Math.random() * 2 - 1) * 0.4;
      d[i] = lp * Math.pow(1 - t, 3.2) * (i < 200 ? i / 200 : 1);
    }
  }
  return buf;
}

interface Layer {
  update(now: number, ctx: AudioContext, day: number, night: number, dawn: number): void;
  stop(at: number): void;
}

class Bank {
  white: AudioBuffer;
  pink: AudioBuffer;
  brown: AudioBuffer;
  constructor(ctx: AudioContext) {
    this.white = noiseBuffer(ctx, 3, 'white');
    this.pink = noiseBuffer(ctx, 5, 'pink');
    this.brown = noiseBuffer(ctx, 5, 'brown');
  }
}

/** A looping noise source through a filter into a gain; returns the gain and filter for automation. */
function loop(ctx: AudioContext, buf: AudioBuffer, type: BiquadFilterType, freq: number, q: number, gain: number, dest: AudioNode) {
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.loopStart = 0;
  src.loopEnd = buf.duration;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(dest);
  src.start(ctx.currentTime, Math.random() * buf.duration);
  return { src, f, g };
}

function panner(ctx: AudioContext, pan: number, dest: AudioNode) {
  const p = ctx.createStereoPanner();
  p.pan.value = Math.max(-1, Math.min(1, pan));
  p.connect(dest);
  return p;
}

// ---------------------------------------------------------------- beds

class OceanBed implements Layer {
  private nodes: { stop(t: number): void }[] = [];
  private voices: { f: BiquadFilterNode; g: GainNode; next: number }[] = [];
  private hiss: GainNode;
  constructor(ctx: AudioContext, bank: Bank, out: AudioNode) {
    const rumble = loop(ctx, bank.brown, 'lowpass', 260, 0.5, 0.55, out);
    this.nodes.push(rumble.src);
    for (let i = 0; i < 3; i++) {
      const p = panner(ctx, (i - 1) * 0.55, out);
      const v = loop(ctx, bank.pink, 'lowpass', 400, 0.7, 0.04, p);
      this.nodes.push(v.src);
      this.voices.push({ f: v.f, g: v.g, next: ctx.currentTime + 0.5 + i * 3.1 });
    }
    const h = loop(ctx, bank.white, 'highpass', 2600, 0.5, 0, out);
    this.nodes.push(h.src);
    this.hiss = h.g;
  }
  update(now: number) {
    for (const v of this.voices) {
      if (v.next > now + 0.6) continue;
      const t0 = Math.max(v.next, now + 0.05);
      const rise = rand(2.2, 3.6);
      const peak = rand(0.55, 1);
      const crash = t0 + rise;
      const fall = rand(3.5, 6);
      v.g.gain.cancelScheduledValues(t0);
      v.g.gain.setValueAtTime(Math.max(v.g.gain.value, 0.03), t0);
      v.g.gain.linearRampToValueAtTime(0.35 * peak, crash - 0.2);
      v.g.gain.linearRampToValueAtTime(0.9 * peak, crash);
      v.g.gain.setTargetAtTime(0.03, crash + 0.1, fall / 3);
      v.f.frequency.cancelScheduledValues(t0);
      v.f.frequency.setValueAtTime(320, t0);
      v.f.frequency.linearRampToValueAtTime(900, crash - 0.15);
      v.f.frequency.linearRampToValueAtTime(2600, crash + 0.05);
      v.f.frequency.setTargetAtTime(450, crash + 0.2, fall / 3);
      this.hiss.gain.setTargetAtTime(0.16 * peak, crash, 0.08);
      this.hiss.gain.setTargetAtTime(0.0, crash + 0.4, fall / 4);
      v.next = t0 + rand(6.5, 11);
    }
  }
  stop(at: number) {
    this.nodes.forEach((n) => n.stop(at));
  }
}

class LakeBed implements Layer {
  private nodes: { stop(t: number): void }[] = [];
  private wind: GainNode;
  private nextWind = 0;
  private nextLap = 0;
  private nextPlip = 0;
  private bank: Bank;
  private out: AudioNode;
  constructor(ctx: AudioContext, bank: Bank, out: AudioNode) {
    this.bank = bank;
    this.out = out;
    const w = loop(ctx, bank.pink, 'bandpass', 520, 0.6, 0.08, out);
    this.nodes.push(w.src);
    this.wind = w.g;
  }
  update(now: number, ctx: AudioContext) {
    if (now > this.nextWind) {
      this.wind.gain.setTargetAtTime(rand(0.03, 0.13), now, rand(1.5, 3));
      this.nextWind = now + rand(3, 7);
    }
    if (now > this.nextLap) {
      // a small wave lapping at the dock posts
      const src = ctx.createBufferSource();
      src.buffer = this.bank.brown;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = rand(220, 480);
      f.Q.value = 1.2;
      const g = ctx.createGain();
      const t = now + 0.05;
      const len = rand(0.25, 0.5);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(rand(0.25, 0.5), t + 0.06);
      g.gain.exponentialRampToValueAtTime(0.001, t + len);
      src.connect(f).connect(g).connect(panner(ctx, rand(-0.5, 0.5), this.out));
      src.start(t, rand(0, 4));
      src.stop(t + len + 0.05);
      this.nextLap = now + rand(0.7, 2.2);
    }
    if (now > this.nextPlip) {
      bubble(ctx, this.out, now + 0.02, rand(500, 900), rand(1.5, 2), 0.05, 0.06, rand(-0.7, 0.7));
      this.nextPlip = now + rand(2, 7);
    }
  }
  stop(at: number) {
    this.nodes.forEach((n) => n.stop(at));
  }
}

class RiverBed implements Layer {
  private nodes: { stop(t: number): void }[] = [];
  private rush: GainNode;
  private nextMod = 0;
  private nextBubble = 0;
  private out: AudioNode;
  constructor(ctx: AudioContext, bank: Bank, out: AudioNode) {
    this.out = out;
    const r = loop(ctx, bank.white, 'bandpass', 1300, 0.45, 0.13, out);
    const low = loop(ctx, bank.brown, 'lowpass', 420, 0.5, 0.45, out);
    this.nodes.push(r.src, low.src);
    this.rush = r.g;
  }
  update(now: number, ctx: AudioContext) {
    if (now > this.nextMod) {
      this.rush.gain.setTargetAtTime(rand(0.09, 0.16), now, 0.8);
      this.nextMod = now + rand(1, 3);
    }
    // babbling: a stream of tiny resonating bubbles
    while (this.nextBubble < now + 0.15) {
      const t = Math.max(this.nextBubble, now);
      bubble(ctx, this.out, t, rand(350, 1500), rand(1.3, 2.1), rand(0.015, 0.06), rand(0.012, 0.045), rand(-0.9, 0.9));
      this.nextBubble = t + rand(0.015, 0.07);
    }
  }
  stop(at: number) {
    this.nodes.forEach((n) => n.stop(at));
  }
}

function bubble(ctx: AudioContext, out: AudioNode, t: number, f0: number, rise: number, dur: number, vol: number, pan: number) {
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f0 * rise, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
  o.connect(g).connect(panner(ctx, pan, out));
  o.start(t);
  o.stop(t + dur + 0.02);
}

// ---------------------------------------------------------------- wildlife

class Wildlife implements Layer {
  private out: AudioNode;
  private birds: boolean;
  private gulls: boolean;
  private crickets: boolean;
  private frogs: boolean;
  private nextBird = 0;
  private nextGull = 4;
  private nextFrog = 2;
  private cricketVoices: { o: OscillatorNode; g: GainNode; next: number; rate: number; pulses: number }[] = [];
  private cricketBus: GainNode;

  constructor(ctx: AudioContext, out: AudioNode, kinds: { birds: boolean; gulls: boolean; crickets: boolean; frogs: boolean }) {
    this.out = out;
    ({ birds: this.birds, gulls: this.gulls, crickets: this.crickets, frogs: this.frogs } = kinds);
    this.cricketBus = ctx.createGain();
    this.cricketBus.gain.value = 0;
    this.cricketBus.connect(out);
    if (this.crickets) {
      for (let i = 0; i < 4; i++) {
        const o = ctx.createOscillator();
        o.frequency.value = rand(4200, 5000);
        const g = ctx.createGain();
        g.gain.value = 0;
        o.connect(g).connect(panner(ctx, rand(-0.9, 0.9), this.cricketBus));
        o.start();
        this.cricketVoices.push({ o, g, next: ctx.currentTime + rand(0, 1), rate: rand(0.45, 0.85), pulses: 2 + Math.floor(rand(1, 3)) });
      }
    }
  }

  update(now: number, ctx: AudioContext, day: number, night: number, dawn: number) {
    if (this.birds && day > 0.15 && now > this.nextBird) {
      this.birdPhrase(ctx, now + 0.05, day);
      this.nextBird = now + rand(2.5, 8) / (1 + dawn * 2);
    }
    if (this.gulls && day > 0.3 && now > this.nextGull) {
      this.gull(ctx, now + 0.05);
      this.nextGull = now + rand(9, 24);
    }
    if (this.frogs && night > 0.4 && now > this.nextFrog) {
      this.frog(ctx, now + 0.05, night);
      this.nextFrog = now + rand(1.5, 6);
    }
    this.cricketBus.gain.setTargetAtTime(this.crickets ? night * 0.5 : 0, now, 1.5);
    if (night > 0.05) {
      for (const v of this.cricketVoices) {
        while (v.next < now + 0.5) {
          let t = Math.max(v.next, now);
          for (let p = 0; p < v.pulses; p++) {
            v.g.gain.setValueAtTime(0, t);
            v.g.gain.linearRampToValueAtTime(0.045, t + 0.004);
            v.g.gain.setValueAtTime(0.045, t + 0.016);
            v.g.gain.linearRampToValueAtTime(0, t + 0.02);
            t += 0.034;
          }
          v.next = t + v.rate * rand(0.85, 1.15);
        }
      }
    }
  }

  private birdPhrase(ctx: AudioContext, t: number, day: number) {
    const notes = 2 + Math.floor(rand(0, 5));
    const base = rand(2200, 4200);
    const pan = rand(-0.9, 0.9);
    const p = panner(ctx, pan, this.out);
    const vol = rand(0.015, 0.045) * day;
    const style = Math.random();
    for (let i = 0; i < notes; i++) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const dur = rand(0.06, 0.16);
      const f0 = base * rand(0.85, 1.2);
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f0 * (style < 0.5 ? rand(1.2, 1.6) : rand(0.6, 0.85)), t + dur);
      if (style > 0.7) {
        const lfo = ctx.createOscillator();
        lfo.frequency.value = rand(25, 55);
        const depth = ctx.createGain();
        depth.gain.value = f0 * 0.08;
        lfo.connect(depth).connect(o.frequency);
        lfo.start(t);
        lfo.stop(t + dur + 0.02);
      }
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0003, t + dur);
      o.connect(g).connect(p);
      o.start(t);
      o.stop(t + dur + 0.02);
      t += dur + rand(0.03, 0.12);
    }
  }

  private gull(ctx: AudioContext, t: number) {
    const p = panner(ctx, rand(-0.8, 0.8), this.out);
    const calls = 1 + Math.floor(rand(0, 3));
    for (let c = 0; c < calls; c++) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 1800;
      f.Q.value = 1.5;
      const g = ctx.createGain();
      const dur = rand(0.28, 0.42);
      o.frequency.setValueAtTime(rand(1300, 1550), t);
      o.frequency.linearRampToValueAtTime(rand(1700, 1900), t + dur * 0.25);
      o.frequency.exponentialRampToValueAtTime(rand(800, 1000), t + dur);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.03, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
      o.connect(f).connect(g).connect(p);
      o.start(t);
      o.stop(t + dur + 0.02);
      t += dur + rand(0.08, 0.2);
    }
  }

  private frog(ctx: AudioContext, t: number, night: number) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = rand(140, 240);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = rand(550, 900);
    f.Q.value = 5;
    const g = ctx.createGain();
    g.gain.value = 0;
    const pulses = 3 + Math.floor(rand(0, 5));
    const vol = rand(0.03, 0.07) * night;
    let tt = t;
    for (let i = 0; i < pulses; i++) {
      g.gain.setValueAtTime(0, tt);
      g.gain.linearRampToValueAtTime(vol, tt + 0.01);
      g.gain.linearRampToValueAtTime(0, tt + 0.045);
      tt += 0.055;
    }
    o.connect(f).connect(g).connect(panner(ctx, rand(-0.8, 0.8), this.out));
    o.start(t);
    o.stop(tt + 0.05);
  }

  stop(at: number) {
    this.cricketVoices.forEach((v) => v.o.stop(at));
  }
}

// ---------------------------------------------------------------- engine

const BEDS: Record<SceneId, (ctx: AudioContext, bank: Bank, out: AudioNode) => Layer> = {
  ocean: (c, b, o) => new OceanBed(c, b, o),
  lake: (c, b, o) => new LakeBed(c, b, o),
  river: (c, b, o) => new RiverBed(c, b, o),
};

const LIFE: Record<SceneId, { birds: boolean; gulls: boolean; crickets: boolean; frogs: boolean }> = {
  ocean: { birds: false, gulls: true, crickets: true, frogs: false },
  lake: { birds: true, gulls: false, crickets: true, frogs: true },
  river: { birds: true, gulls: false, crickets: true, frogs: true },
};

const BED_LEVEL: Record<SceneId, number> = { ocean: 0.9, lake: 0.8, river: 0.75 };

export class AudioEngine implements SoundSink {
  readonly ctx: AudioContext;
  private master: GainNode;
  private sfx: GainNode;
  private reverbSend: GainNode;
  private bank: Bank;
  private bed: { layer: Layer; gain: GainNode } | null = null;
  private life: { layer: Layer; gain: GainNode } | null = null;
  private camera: Camera | null = null;
  private muted = false;
  private tmp = new Vector3();

  constructor() {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor({ latencyHint: 'interactive' });
    const ctx = this.ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 3;
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(comp);
    const reverb = ctx.createConvolver();
    reverb.buffer = impulse(ctx, 1.8);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.35;
    this.reverbSend.connect(reverb).connect(this.master);
    this.sfx = ctx.createGain();
    this.sfx.gain.value = 0.9;
    this.sfx.connect(this.master);
    this.sfx.connect(this.reverbSend);
    this.bank = new Bank(ctx);
  }

  /** Must be called from a user gesture (tap/click) for browsers to allow sound. */
  async unlock() {
    const nav = navigator as Navigator & { audioSession?: { type: string } };
    // Play through the iPhone ring/silent switch once the user has asked for sound.
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
    const ctx = this.ctx;
    const now = ctx.currentTime;
    for (const old of [this.bed, this.life]) {
      if (!old) continue;
      old.gain.gain.setTargetAtTime(0, now, 0.4);
      old.layer.stop(now + 2.5);
      setTimeout(() => old.gain.disconnect(), 3000);
    }
    const bedGain = ctx.createGain();
    bedGain.gain.value = 0;
    bedGain.gain.setTargetAtTime(BED_LEVEL[id], now + 0.3, 0.8);
    bedGain.connect(this.master);
    this.bed = { layer: BEDS[id](ctx, this.bank, bedGain), gain: bedGain };
    const lifeGain = ctx.createGain();
    lifeGain.gain.value = 0;
    lifeGain.gain.setTargetAtTime(1, now + 0.3, 0.8);
    lifeGain.connect(this.master);
    lifeGain.connect(this.reverbSend);
    this.life = { layer: new Wildlife(ctx, lifeGain, LIFE[id]), gain: lifeGain };
  }

  update(camera: Camera, night: number, sunAltDeg: number, morning: boolean) {
    this.camera = camera;
    if (this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    const day = 1 - night;
    const dawn = morning ? Math.max(0, 1 - Math.abs(sunAltDeg - 4) / 10) : 0;
    this.bed?.layer.update(now, this.ctx, day, night, dawn);
    this.life?.layer.update(now, this.ctx, day, night, dawn);
  }

  /** Gain and stereo position for a sound at a world position. */
  private place(pos: Vector3): { gain: number; pan: number } {
    if (!this.camera) return { gain: 1, pan: 0 };
    const local = this.tmp.copy(pos).applyMatrix4(this.camera.matrixWorldInverse);
    const dist = local.length();
    return { gain: 1 / (1 + dist / 10), pan: Math.max(-0.9, Math.min(0.9, local.x / (Math.abs(local.z) + 3))) };
  }

  private burst(t: number, dur: number, freq: number, q: number, vol: number, dest: AudioNode, type: BiquadFilterType = 'bandpass') {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.bank.white;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 2);
    src.stop(t + dur + 0.02);
  }

  splash(kind: 'tap' | 'plunge' | 'skip' | 'land', pos: Vector3, energy: number) {
    const ctx = this.ctx;
    if (ctx.state !== 'running' || this.muted) return;
    const t = ctx.currentTime + 0.01;
    const { gain, pan } = this.place(pos);
    const out = ctx.createGain();
    out.gain.value = gain;
    out.connect(panner(ctx, pan, this.sfx));
    setTimeout(() => out.disconnect(), 2500);
    if (kind === 'tap') {
      this.burst(t, 0.13, 2300, 0.8, 0.45, out);
      bubble(ctx, out, t + 0.01, rand(600, 950), rand(1.6, 2.2), 0.06, 0.18, 0);
      for (let i = 0; i < 4; i++) bubble(ctx, out, t + rand(0.08, 0.35), rand(1800, 3800), 1.3, 0.025, 0.05, rand(-0.3, 0.3));
    } else if (kind === 'plunge') {
      const e = 0.5 + energy * 0.5;
      const thump = ctx.createOscillator();
      const tg = ctx.createGain();
      thump.frequency.setValueAtTime(120, t);
      thump.frequency.exponentialRampToValueAtTime(50, t + 0.14);
      tg.gain.setValueAtTime(0.5 * e, t);
      tg.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      thump.connect(tg).connect(out);
      thump.start(t);
      thump.stop(t + 0.2);
      bubble(ctx, out, t + 0.02, rand(250, 330), rand(2.4, 3), 0.09, 0.4 * e, 0);
      this.burst(t, 0.32, 1500, 0.7, 0.55 * e, out);
      for (let i = 0; i < 6; i++) bubble(ctx, out, t + rand(0.25, 0.8), rand(1500, 3500), 1.2, 0.03, 0.05 * e, rand(-0.4, 0.4));
    } else if (kind === 'skip') {
      this.burst(t, 0.05, 3200, 1.0, 0.35 * (0.4 + energy), out, 'highpass');
      bubble(ctx, out, t + 0.005, rand(900, 1300), 1.6, 0.03, 0.1, 0);
    } else {
      this.burst(t, 0.03, 3500, 2, 0.35, out);
      const k = ctx.createOscillator();
      const kg = ctx.createGain();
      k.frequency.setValueAtTime(320, t);
      k.frequency.exponentialRampToValueAtTime(190, t + 0.05);
      kg.gain.setValueAtTime(0.18, t);
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
    src.buffer = this.bank.white;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.2;
    f.frequency.setValueAtTime(500, t);
    f.frequency.exponentialRampToValueAtTime(1800 + power * 1500, t + 0.22);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.05 + power * 0.08, t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.28);
    src.connect(f).connect(g).connect(panner(ctx, 0.35, this.sfx));
    src.start(t, Math.random());
    src.stop(t + 0.3);
  }
}
