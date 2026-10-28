export interface GestureHandlers {
  tap(ndcX: number, ndcY: number): void;
  /** Swipe velocity in screen heights per second (up is positive). */
  flick(up: number, side: number, startNdcX: number): void;
  /** Any touch at all, used to wake the UI. */
  activity(): void;
}

interface Track {
  x0: number;
  y0: number;
  t0: number;
  samples: { x: number; y: number; t: number }[];
}

/**
 * Turns pointer input on the canvas into taps (splash) and upward flicks
 * (throw a stone). Works the same for mouse, pen and multi-touch.
 */
export class Gestures {
  private tracks = new Map<number, Track>();
  private el: HTMLElement;
  private h: GestureHandlers;

  constructor(el: HTMLElement, handlers: GestureHandlers) {
    this.el = el;
    this.h = handlers;
    el.addEventListener('pointerdown', this.down);
    el.addEventListener('pointermove', this.move);
    el.addEventListener('pointerup', this.up);
    el.addEventListener('pointercancel', this.cancel);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private down = (e: PointerEvent) => {
    if (e.button > 0) return;
    this.el.setPointerCapture?.(e.pointerId);
    const t = performance.now();
    this.tracks.set(e.pointerId, { x0: e.clientX, y0: e.clientY, t0: t, samples: [{ x: e.clientX, y: e.clientY, t }] });
    this.h.activity();
  };

  private move = (e: PointerEvent) => {
    const tr = this.tracks.get(e.pointerId);
    if (!tr) return;
    const t = performance.now();
    tr.samples.push({ x: e.clientX, y: e.clientY, t });
    while (tr.samples.length > 2 && t - tr.samples[0].t > 120) tr.samples.shift();
  };

  private up = (e: PointerEvent) => {
    const tr = this.tracks.get(e.pointerId);
    if (!tr) return;
    this.tracks.delete(e.pointerId);
    const t = performance.now();
    tr.samples.push({ x: e.clientX, y: e.clientY, t });
    const rect = this.el.getBoundingClientRect();
    const dx = e.clientX - tr.x0;
    const dy = e.clientY - tr.y0;
    const moved = Math.hypot(dx, dy);
    const dur = t - tr.t0;
    if (moved < 14 && dur < 450) {
      const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const ny = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
      this.h.tap(nx, ny);
      return;
    }
    // Velocity over the last ~100 ms of the gesture.
    const first = tr.samples[0];
    const span = Math.max(t - first.t, 16) / 1000;
    const vx = (e.clientX - first.x) / span;
    const vy = (e.clientY - first.y) / span;
    if (dy < -24 && vy < 0) {
      const startNdcX = ((tr.x0 - rect.left) / rect.width) * 2 - 1;
      this.h.flick(-vy / rect.height, vx / rect.height, startNdcX);
    }
  };

  private cancel = (e: PointerEvent) => {
    this.tracks.delete(e.pointerId);
  };
}
