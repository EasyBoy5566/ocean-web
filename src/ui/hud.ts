import { SCENES, type App } from '../app/app';
import { params } from '../app/params';
import { storedTierChoice, storeTierChoice, type Tier } from '../app/quality';
import type { AudioEngine } from '../audio/engine';
import { sunTimes } from '../env/celestial';
import { requestPreciseLocation, type GeoLocation } from '../env/location';
import type { SceneId } from '../world/world';
import { getLang, onLangChange, setLang, t, type Key } from './i18n';

const ICONS = {
  sound: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  muted: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 9.5l5 5m0-5l-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A7.5 7.5 0 0 0 7 6.5l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 3l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.5 7.5 0 0 0 2.6-1.5l2.4 1 2-3.4-2-1.6z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

const fmtTime = (d: Date) => d.toLocaleTimeString(getLang() === 'zh' ? 'zh-TW' : 'en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));

/** All DOM UI: intro screen, scene tabs, clock and time slider, settings, hints. */
export class Hud {
  private app: App;
  private root: HTMLElement;
  private audio: AudioEngine | null = null;
  private intro!: HTMLElement;
  private hud!: HTMLElement;
  private fade!: HTMLElement;
  private tabs = new Map<SceneId, HTMLButtonElement>();
  private clockTime!: HTMLElement;
  private clockSub!: HTMLElement;
  private slider!: HTMLInputElement;
  private liveBtn!: HTMLButtonElement;
  private timePanel!: HTMLElement;
  private soundBtn!: HTMLButtonElement;
  private settings!: HTMLElement;
  private fpsEl!: HTMLElement;
  private hintEl!: HTMLElement;
  private idleTimer = 0;
  private scrubbing = false;
  private showFps = params.fps;
  private locStatus: string = '';
  private texts: { node: HTMLElement; key: Key; attr?: string }[] = [];
  private lastClock = '';

  constructor(app: App, root: HTMLElement) {
    this.app = app;
    this.root = root;
    this.build();
    onLangChange(() => this.relabel());
    this.relabel();
    app.events.onActivity = () => this.wake();
    app.events.onLocation = (loc) => this.onLocation(loc);
    app.events.onSceneChange = (id) => this.onScene(id);
    app.events.onInteract = () => this.hideHint();
    app.events.onFrame = () => this.frame();
    window.addEventListener('pointerdown', () => this.wake(), { passive: true });
  }

  get fadeEl() {
    return this.fade;
  }

  private label(node: HTMLElement, key: Key, attr?: string) {
    this.texts.push({ node, key, attr });
    return node;
  }

  private relabel() {
    for (const { node, key, attr } of this.texts) {
      if (attr) node.setAttribute(attr, t(key));
      else node.textContent = t(key);
    }
    this.lastClock = '';
    this.renderLocation();
    this.renderSettings();
  }

  private build() {
    this.fade = el('div', 'fade');
    this.root.append(this.fade);

    // Intro
    this.intro = el('div', 'intro');
    const card = el('div', 'intro-card');
    const lang = el('button', 'lang-toggle');
    lang.addEventListener('click', () => setLang(getLang() === 'zh' ? 'en' : 'zh'));
    this.texts.push({ node: lang, key: 'language', attr: 'aria-label' });
    const updLang = () => (lang.textContent = getLang() === 'zh' ? 'EN' : '中文');
    onLangChange(updLang);
    updLang();
    const title = this.label(el('h1', 'intro-title'), 'title');
    const sub = this.label(el('p', 'intro-sub'), 'subtitle');
    const loc = el('p', 'intro-loc');
    loc.dataset.role = 'loc';
    const b1 = this.label(el('button', 'btn primary'), 'enterSound');
    const b2 = this.label(el('button', 'btn ghost'), 'enterMuted');
    b1.addEventListener('click', () => this.enter(true));
    b2.addEventListener('click', () => this.enter(false));
    const btns = el('div', 'intro-btns');
    btns.append(b1, b2);
    card.append(title, sub, btns, loc);
    if (isIOS) card.append(this.label(el('p', 'intro-note'), 'iosSilent'));
    this.intro.append(lang, card);
    this.root.append(this.intro);

    // HUD
    this.hud = el('div', 'hud hidden');
    const top = el('nav', 'tabs');
    for (const id of SCENES) {
      const b = this.label(el('button', 'tab'), id as Key) as HTMLButtonElement;
      b.addEventListener('click', () => {
        void this.app.switchScene(id, this.fade);
        history.replaceState(null, '', `#${id}`);
      });
      this.tabs.set(id, b);
      top.append(b);
    }

    const clock = el('button', 'clock');
    this.clockTime = el('span', 'clock-time');
    this.clockSub = el('span', 'clock-sub');
    clock.append(this.clockTime, this.clockSub);
    clock.addEventListener('click', () => this.timePanel.classList.toggle('open'));

    this.timePanel = el('div', 'time-panel');
    this.slider = el('input', 'slider') as HTMLInputElement;
    this.slider.type = 'range';
    this.slider.min = '0';
    this.slider.max = '1439';
    this.slider.step = '1';
    this.label(this.slider, 'scrub', 'aria-label');
    this.slider.addEventListener('input', () => {
      this.scrubbing = true;
      this.app.env.clock.setMinutesOfDay(Number(this.slider.value));
      this.wake();
    });
    this.slider.addEventListener('change', () => (this.scrubbing = false));
    this.liveBtn = this.label(el('button', 'chip'), 'live') as HTMLButtonElement;
    this.liveBtn.addEventListener('click', () => {
      this.app.env.clock.goLive();
      this.wake();
    });
    this.timePanel.append(this.slider, this.liveBtn);

    const left = el('div', 'corner left');
    left.append(this.timePanel, clock);

    this.soundBtn = el('button', 'icon-btn') as HTMLButtonElement;
    this.soundBtn.addEventListener('click', () => this.toggleSound());
    const gear = el('button', 'icon-btn', ICONS.gear) as HTMLButtonElement;
    this.label(gear, 'settings', 'aria-label');
    gear.addEventListener('click', () => this.openSettings());
    const right = el('div', 'corner right');
    right.append(this.soundBtn, gear);

    this.hintEl = el('div', 'hint');
    this.label(this.hintEl, 'hint');

    this.fpsEl = el('div', 'fps');
    this.hud.append(top, left, right, this.hintEl, this.fpsEl);
    this.root.append(this.hud);

    // Settings sheet
    this.settings = el('div', 'sheet');
    this.settings.addEventListener('click', (e) => {
      if (e.target === this.settings) this.settings.classList.remove('open');
    });
    this.root.append(this.settings);
    this.updateSoundIcon();
  }

  private renderSettings() {
    if (!this.settings) return;
    const s = this.settings;
    s.innerHTML = '';
    const panel = el('div', 'sheet-panel');
    const h = el('h2', '', t('settings'));
    panel.append(h);

    const row = (labelKey: Key, content: HTMLElement) => {
      const r = el('div', 'row');
      r.append(el('span', 'row-label', t(labelKey)), content);
      panel.append(r);
    };
    const seg = <T extends string>(opts: [T, string][], current: T, onPick: (v: T) => void) => {
      const g = el('div', 'seg');
      for (const [v, label] of opts) {
        const b = el('button', v === current ? 'on' : '', label);
        b.addEventListener('click', () => {
          onPick(v);
          this.renderSettings();
        });
        g.append(b);
      }
      return g;
    };

    const tierChoice = storedTierChoice();
    row('quality', seg<Tier | 'auto'>([['auto', t('auto')], ['high', t('high')], ['medium', t('medium')], ['low', t('low')]], tierChoice, (v) => {
      storeTierChoice(v);
      // 'auto' re-detects on next load; apply a concrete tier now
      if (v !== 'auto') this.app.setTier(v);
    }));
    row('language', seg<'zh' | 'en'>([['zh', '繁體中文'], ['en', 'English']], getLang(), (v) => setLang(v)));
    if (this.audio) {
      row('sound', seg<'on' | 'off'>([['on', t('on')], ['off', t('off')]], this.audio.isMuted ? 'off' : 'on', (v) => {
        this.audio?.setMuted(v === 'off');
        this.updateSoundIcon();
      }));
    }
    row('showFps', seg<'on' | 'off'>([['on', t('on')], ['off', t('off')]], this.showFps ? 'on' : 'off', (v) => {
      this.showFps = v === 'on';
    }));

    const locBox = el('div', 'loc-box');
    const status = el('div', 'loc-status', this.locStatus);
    const preciseBtn = el('button', 'chip', t('locPrecise'));
    preciseBtn.addEventListener('click', async () => {
      status.textContent = t('locating');
      try {
        const loc = await requestPreciseLocation();
        this.app.setLocation(loc);
      } catch {
        status.textContent = t('locDenied');
      }
    });
    locBox.append(status, preciseBtn, el('p', 'note', t('locNote')));
    row('location', locBox);
    panel.append(el('p', 'note', t('about')));
    const done = el('button', 'btn primary small', t('close'));
    done.addEventListener('click', () => s.classList.remove('open'));
    panel.append(done);
    s.append(panel);
  }

  private openSettings() {
    this.renderSettings();
    this.settings.classList.add('open');
  }

  private async enter(withSound: boolean) {
    this.intro.classList.add('gone');
    this.hud.classList.remove('hidden');
    if (withSound) {
      try {
        const { AudioEngine } = await import('../audio/engine');
        this.audio = new AudioEngine();
        await this.audio.unlock();
        this.audio.setScene(this.app.sceneId);
        this.app.setSound(this.audio);
        document.addEventListener('visibilitychange', () => {
          if (document.hidden) this.audio?.suspend();
          else this.audio?.resume();
        });
      } catch (e) {
        console.warn('Audio unavailable', e);
        this.audio = null;
      }
    }
    this.updateSoundIcon();
    this.renderSettings();
    this.showHint();
    this.wake();
  }

  /** Skip the intro (used by ?autostart and screenshots). */
  autostart() {
    this.intro.classList.add('gone');
    this.hud.classList.remove('hidden');
    if (params.shot) this.hud.classList.add('hidden');
  }

  private async toggleSound() {
    if (!this.audio) {
      await this.enter(true);
      return;
    }
    this.audio.setMuted(!this.audio.isMuted);
    this.updateSoundIcon();
  }

  private updateSoundIcon() {
    const on = !!this.audio && !this.audio.isMuted;
    this.soundBtn.innerHTML = on ? ICONS.sound : ICONS.muted;
    this.soundBtn.setAttribute('aria-label', `${t('sound')}: ${on ? t('on') : t('off')}`);
  }

  private showHint() {
    let shown = 0;
    try {
      shown = Number(localStorage.getItem('waterscape.hints') ?? 0);
      localStorage.setItem('waterscape.hints', String(shown + 1));
    } catch {
      /* ignore */
    }
    if (shown >= 3) return;
    this.hintEl.classList.add('show');
    setTimeout(() => this.hideHint(), 9000);
  }

  private hideHint() {
    this.hintEl.classList.remove('show');
  }

  private wake() {
    this.hud.classList.remove('idle');
    clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => {
      if (!this.timePanel.classList.contains('open') && !this.settings.classList.contains('open')) this.hud.classList.add('idle');
    }, 7000);
  }

  private onScene(id: SceneId) {
    this.tabs.forEach((b, k) => b.classList.toggle('on', k === id));
    this.audio?.setScene(id);
    this.lastClock = '';
  }

  private onLocation(loc: GeoLocation) {
    const src: Record<GeoLocation['source'], Key> = { gps: 'locGps', ip: 'locIp', timezone: 'locTz', default: 'locDefault', param: 'locParam' };
    this.locStatus = `${loc.label ? `${loc.label} · ` : ''}${loc.lat.toFixed(2)}°, ${loc.lon.toFixed(2)}° — ${t(src[loc.source])}`;
    this.lastClock = '';
    this.renderLocation();
    this.renderSettings();
  }

  private renderLocation() {
    const node = this.root.querySelector<HTMLElement>('[data-role="loc"]');
    if (node) node.textContent = this.locStatus;
  }

  private frame() {
    const env = this.app.env;
    const now = env.clock.now();
    const key = `${now.getHours()}:${now.getMinutes()}:${env.clock.isLive}:${getLang()}`;
    if (key !== this.lastClock) {
      this.lastClock = key;
      this.clockTime.textContent = fmtTime(now);
      const st = sunTimes(now, env.location.lat, env.location.lon);
      const rise = st.sunrise && !Number.isNaN(st.sunrise.getTime()) ? fmtTime(st.sunrise) : '—';
      const set = st.sunset && !Number.isNaN(st.sunset.getTime()) ? fmtTime(st.sunset) : '—';
      const place = env.location.label ? `${env.location.label} · ` : '';
      this.clockSub.textContent = `${place}${t('sunrise')} ${rise} · ${t('sunset')} ${set}`;
      this.liveBtn.classList.toggle('on', env.clock.isLive);
    }
    if (!this.scrubbing) this.slider.value = String(Math.floor(env.clock.minutesOfDay()));
    this.fpsEl.style.display = this.showFps ? 'block' : 'none';
    if (this.showFps) this.fpsEl.textContent = `${this.app.fps.toFixed(0)} fps · ${this.app.tier.tier} · ×${this.app.pixelRatio.toFixed(2)}`;
    if (this.audio && this.app.world) {
      const hours = now.getHours();
      this.audio.update(this.app.world.camera, env.night, env.sunAltDeg, hours < 12);
    }
  }
}
