import { params } from '../app/params';

/**
 * Scene clock. Shows real time by default; scrubbing the time slider shifts it
 * to another minute of the same day, after which it keeps running normally.
 */
export class SceneClock {
  private anchorReal = Date.now();
  private anchorShown = Date.now();
  private speed = 1;

  constructor() {
    const shown = new Date();
    if (params.date) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(params.date);
      if (m) shown.setFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    }
    if (params.time) {
      const m = /^(\d{1,2}):(\d{2})$/.exec(params.time);
      if (m) shown.setHours(Number(m[1]), Number(m[2]), 0, 0);
    }
    this.anchorShown = shown.getTime();
    this.speed = params.speed ?? 1;
  }

  get isLive() {
    return this.speed === 1 && Math.abs(this.anchorShown - this.anchorReal) < 1000;
  }

  now(): Date {
    return new Date(this.anchorShown + (Date.now() - this.anchorReal) * this.speed);
  }

  /** Jump to a minute of the currently shown day. */
  setMinutesOfDay(minutes: number) {
    const d = this.now();
    d.setHours(0, 0, 0, 0);
    this.anchorShown = d.getTime() + minutes * 60000;
    this.anchorReal = Date.now();
  }

  goLive() {
    this.anchorReal = this.anchorShown = Date.now();
    this.speed = 1;
  }

  minutesOfDay(): number {
    const d = this.now();
    return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  }
}
