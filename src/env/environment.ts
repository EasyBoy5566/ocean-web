import type { WebGLRenderer } from 'three';
import { params } from '../app/params';
import { globals } from '../gfx/globals';
import { SkyDome, SkyLUT } from '../gfx/sky';
import { clamp, lerp, smoothstep } from '../util/math';
import {
  luminance, MOON_SCALE, msBoost, NIGHT_BASE, skyRadiance, SUN_I, transmittance, type RGB, type Vec3,
} from './atmosphere';
import { computeCelestial, createCelestialState } from './celestial';
import { DEFAULT_LOCATION, type GeoLocation } from './location';
import { SceneClock } from './time';

export interface EnvironmentConfig {
  /** Compass direction the camera faces, degrees from north. */
  heading: number;
  fogDensity: number;
  /** Maximum mist amount (reached around dawn). */
  mist: number;
  mistHeight: number;
  cloudCover: number;
  windDir: [number, number];
}

/** Diffuse irradiance factor applied to sunlight in materials. */
const K_SUN = 0.2;
const K_CLOUD = 0.075;
const EXPOSURE_KEY = 0.85;

/** Directions the fixed camera actually sees (it looks down -Z): used for metering. */
const VIEW_DIRS: Vec3[] = [[0, 4], [0, 15], [-28, 8], [28, 8], [0, 32]].map(([az, alt]) => {
  const a = (alt * Math.PI) / 180, z = (az * Math.PI) / 180;
  return { x: Math.cos(a) * Math.sin(z), y: Math.sin(a), z: -Math.cos(a) * Math.cos(z) };
});

const SAMPLE_DIRS: Vec3[] = (() => {
  const dirs: Vec3[] = [{ x: 0, y: 1, z: 0 }];
  for (let i = 0; i < 6; i++) {
    const az = (i / 6) * Math.PI * 2;
    const alt = 0.42;
    dirs.push({ x: Math.cos(alt) * Math.sin(az), y: Math.sin(alt), z: -Math.cos(alt) * Math.cos(az) });
  }
  return dirs;
})();

/**
 * Owns the clock, location, celestial bodies and atmosphere, and pushes the
 * resulting light colours and exposure into the shared shader uniforms.
 */
export class Environment {
  readonly clock = new SceneClock();
  location: GeoLocation = DEFAULT_LOCATION;
  readonly celestial = createCelestialState();
  readonly lut = new SkyLUT();
  readonly dome = new SkyDome();
  exposure = 1;
  /** 0 = full day, 1 = full night. */
  night = 0;
  sunAltDeg = 0;
  private cfg: EnvironmentConfig = {
    heading: 90, fogDensity: 1.5e-4, mist: 0, mistHeight: 12, cloudCover: 0.35, windDir: [1, 0.3],
  };
  private exposureReady = false;
  private lutAge = 1e9;
  private lastLutSun = { x: 0, y: 0, z: 0 };
  private atmAge = 1e9;
  private moonIntensity = 0;
  private tmp: RGB = [0, 0, 0];
  private sum: RGB = [0, 0, 0];

  configure(cfg: EnvironmentConfig) {
    this.cfg = cfg;
    globals.uFogDensity.value = cfg.fogDensity * (params.fog ?? 1);
    globals.uMistHeight.value = cfg.mistHeight;
    this.dome.uniforms.uCloudCover.value = cfg.cloudCover;
    const w = Math.hypot(cfg.windDir[0], cfg.windDir[1]) || 1;
    this.dome.uniforms.uWind.value.set((cfg.windDir[0] / w) * 0.0011, (cfg.windDir[1] / w) * 0.0011, 0);
    this.lutAge = this.atmAge = 1e9;
    this.exposureReady = false;
  }

  get heading() {
    return this.cfg.heading;
  }

  update(renderer: WebGLRenderer, dt: number, time: number) {
    globals.uTime.value = time;
    const date = this.clock.now();
    const c = this.celestial;
    computeCelestial(date, this.location.lat, this.location.lon, this.cfg.heading, c);
    globals.uSunDir.value.copy(c.sunDir);
    globals.uMoonDir.value.copy(c.moonDir);
    this.sunAltDeg = (c.sunAlt * 180) / Math.PI;
    this.night = smoothstep(-0.02, -0.13, c.sunDir.y);
    globals.uNight.value = this.night;

    this.atmAge += dt;
    if (this.atmAge > 0.1) {
      this.atmAge = 0;
      this.updateLights();
    }

    // Exposure adapts in log space, quickly enough to follow the time slider.
    const target = this.targetExposure();
    if (!this.exposureReady) {
      this.exposure = target;
      this.exposureReady = true;
    } else {
      const k = 1 - Math.exp(-dt * 2.5);
      this.exposure = Math.exp(lerp(Math.log(this.exposure), Math.log(target), k));
    }
    renderer.toneMappingExposure = this.exposure;
    globals.uExposure.value = this.exposure;

    const shown = luminance(this.ambient) * this.exposure;
    this.dome.uniforms.uStarVis.value = 1 - smoothstep(0.035, 0.16, shown);
    this.dome.uniforms.uMoonDiscI.value = 0.6 * Math.pow(this.exposure, -0.8);
    this.dome.uniforms.uStarMat.value.copy(c.starMatrix);

    // Mist peaks around dawn and lingers a little at night.
    const hours = date.getHours() + date.getMinutes() / 60;
    const dawn = smoothstep(-10, -2, this.sunAltDeg) * (1 - smoothstep(6, 22, this.sunAltDeg)) * (hours < 12 ? 1 : 0.25);
    globals.uMist.value = (params.fog ?? 1) * this.cfg.mist * clamp(0.06 + 0.94 * dawn + 0.25 * this.night, 0, 1);

    this.lutAge += dt;
    const moved = Math.abs(c.sunDir.x - this.lastLutSun.x) + Math.abs(c.sunDir.y - this.lastLutSun.y) + Math.abs(c.sunDir.z - this.lastLutSun.z);
    if (this.lutAge > 0.5 || moved > 0.002) {
      this.lutAge = 0;
      this.lastLutSun = { x: c.sunDir.x, y: c.sunDir.y, z: c.sunDir.z };
      this.lut.update(renderer, this.moonIntensity, msBoost(c.sunDir.y));
    }
  }

  private ambient: RGB = [0, 0, 0];
  private viewLum = 0;

  private updateLights() {
    const c = this.celestial;
    const sun = c.sunDir, moon = c.moonDir;
    const sunT = transmittance(20, sun, [0, 0, 0]);
    const sunFade = smoothstep(-0.0095, 0.0045, sun.y);
    globals.uSunColor.value.setRGB(sunT[0] * SUN_I * K_SUN * sunFade, sunT[1] * SUN_I * K_SUN * sunFade, sunT[2] * SUN_I * K_SUN * sunFade);
    this.dome.uniforms.uSunDisc.value.setRGB(sunT[0] * SUN_I * 2500, sunT[1] * SUN_I * 2500, sunT[2] * SUN_I * 2500);

    this.moonIntensity = SUN_I * MOON_SCALE * c.moonFraction;
    const moonT = transmittance(20, moon, [0, 0, 0]);
    const moonFade = smoothstep(-0.0095, 0.0045, moon.y);
    // Slightly blue moonlight: the eye's night vision shifts perception to blue.
    const mk = this.moonIntensity * K_SUN * moonFade * 1.6;
    globals.uMoonColor.value.setRGB(moonT[0] * mk * 0.78, moonT[1] * mk * 0.9, moonT[2] * mk * 1.15);
    this.dome.uniforms.uMoonTint.value.setRGB(Math.pow(moonT[0], 0.35), Math.pow(moonT[1], 0.35), Math.pow(moonT[2], 0.35));

    const s = this.sum;
    s[0] = s[1] = s[2] = 0;
    let wsum = 0;
    for (let i = 0; i < SAMPLE_DIRS.length; i++) {
      const w = i === 0 ? 1.5 : 1;
      const d = SAMPLE_DIRS[i];
      skyRadiance(20, d, sun, SUN_I, this.tmp);
      s[0] += this.tmp[0] * w; s[1] += this.tmp[1] * w; s[2] += this.tmp[2] * w;
      if (this.moonIntensity > 0) {
        skyRadiance(20, d, moon, this.moonIntensity, this.tmp);
        s[0] += this.tmp[0] * w; s[1] += this.tmp[1] * w; s[2] += this.tmp[2] * w;
      }
      wsum += w;
    }
    const boost = msBoost(sun.y);
    let view = 0;
    for (const d of VIEW_DIRS) {
      view += luminance(skyRadiance(20, d, sun, SUN_I, this.tmp));
      if (this.moonIntensity > 0) view += luminance(skyRadiance(20, d, moon, this.moonIntensity, this.tmp));
    }
    this.viewLum = (view / VIEW_DIRS.length) * boost;
    const a = this.ambient;
    for (let i = 0; i < 3; i++) a[i] = (s[i] / wsum) * boost + NIGHT_BASE[i];
    globals.uSkyAmbient.value.setRGB(a[0], a[1], a[2]);
    const bounce = Math.max(sun.y, 0) * 0.06;
    const sc = globals.uSunColor.value;
    globals.uGroundAmbient.value.setRGB(a[0] * 0.3 + sc.r * bounce, a[1] * 0.3 + sc.g * bounce, a[2] * 0.3 + sc.b * bounce);

    const cloudT = transmittance(2200, sun, [0, 0, 0]);
    const cf = smoothstep(-0.045, 0.0, sun.y);
    this.dome.uniforms.uCloudSun.value.setRGB(cloudT[0] * SUN_I * K_CLOUD * cf, cloudT[1] * SUN_I * K_CLOUD * cf, cloudT[2] * SUN_I * K_CLOUD * cf);
    const cloudMT = transmittance(2200, moon, [0, 0, 0]);
    const mc = this.moonIntensity * K_CLOUD * smoothstep(-0.045, 0.0, moon.y);
    this.dome.uniforms.uCloudMoon.value.setRGB(cloudMT[0] * mc, cloudMT[1] * mc, cloudMT[2] * mc);
  }

  private targetExposure() {
    const sc = globals.uSunColor.value;
    // Meter mostly on the sky in frame, like a camera would, plus the overall light level.
    const lum = this.viewLum * 0.6 + luminance(this.ambient) * 0.4 + 0.03 * (0.2126 * sc.r + 0.7152 * sc.g + 0.0722 * sc.b);
    return clamp(EXPOSURE_KEY * Math.pow(Math.max(lum, 1e-7), -0.7), 0.2, 5000);
  }

  setCloudOctaves(n: number) {
    this.dome.uniforms.uCloudOctaves.value = n;
  }

  dispose() {
    this.lut.dispose();
    this.dome.dispose();
  }
}
