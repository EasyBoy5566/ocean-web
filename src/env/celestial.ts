import SunCalc from 'suncalc';
import { Matrix3, Vector3 } from 'three';
import { DEG } from '../util/math';

/**
 * Converts a horizontal direction (azimuth from north, clockwise; altitude)
 * into world space for a scene whose camera looks along -Z towards `headingDeg`.
 */
export function horizontalToWorld(azNorth: number, alt: number, headingDeg: number, out: Vector3): Vector3 {
  const e = Math.cos(alt) * Math.sin(azNorth);
  const n = Math.cos(alt) * Math.cos(azNorth);
  const u = Math.sin(alt);
  const h = headingDeg * DEG;
  return out.set(e * Math.cos(h) - n * Math.sin(h), u, -(e * Math.sin(h) + n * Math.cos(h)));
}

/** Atmospheric refraction (Bennett), radians to add to a geometric altitude. */
function refraction(alt: number): number {
  const a = Math.max(alt / DEG, -1.5);
  const arcmin = 1.02 / Math.tan((a + 10.3 / (a + 5.11)) * DEG);
  return Math.max(arcmin, 0) / 60 * DEG;
}

export interface CelestialState {
  sunDir: Vector3;
  moonDir: Vector3;
  sunAlt: number;
  moonAlt: number;
  moonFraction: number;
  /** World → equatorial rotation for the star field (use as `dir * M` in GLSL). */
  starMatrix: Matrix3;
}

export function createCelestialState(): CelestialState {
  return {
    sunDir: new Vector3(0, 1, 0),
    moonDir: new Vector3(0, -1, 0),
    sunAlt: 0,
    moonAlt: 0,
    moonFraction: 0,
    starMatrix: new Matrix3(),
  };
}

const enuToWorld = new Matrix3();
const eqToEnu = new Matrix3();

export function computeCelestial(date: Date, lat: number, lon: number, headingDeg: number, out: CelestialState) {
  const sun = SunCalc.getPosition(date, lat, lon);
  out.sunAlt = sun.altitude + refraction(sun.altitude);
  horizontalToWorld(sun.azimuth + Math.PI, out.sunAlt, headingDeg, out.sunDir);

  const moon = SunCalc.getMoonPosition(date, lat, lon);
  out.moonAlt = moon.altitude + refraction(moon.altitude);
  horizontalToWorld(moon.azimuth + Math.PI, out.moonAlt, headingDeg, out.moonDir);
  out.moonFraction = SunCalc.getMoonIllumination(date).fraction;

  // Local sidereal time → rotation of the celestial sphere.
  const jd = date.getTime() / 86400000 + 2440587.5;
  const d = jd - 2451545.0;
  const gmstHours = 18.697374558 + 24.06570982441908 * d;
  const lst = ((((gmstHours + lon / 15) % 24) + 24) % 24) * 15 * DEG;
  const phi = lat * DEG;
  const sl = Math.sin(lst), cl = Math.cos(lst), sp = Math.sin(phi), cp = Math.cos(phi);
  // Equatorial (x→RA 0h, z→north pole) to east/north/up.
  eqToEnu.set(
    -sl, cl, 0,
    -sp * cl, -sp * sl, cp,
    cp * cl, cp * sl, sp,
  );
  const h = headingDeg * DEG;
  const sh = Math.sin(h), ch = Math.cos(h);
  enuToWorld.set(
    ch, -sh, 0,
    0, 0, 1,
    -sh, -ch, 0,
  );
  out.starMatrix.multiplyMatrices(enuToWorld, eqToEnu);
}

export function sunTimes(date: Date, lat: number, lon: number) {
  const t = SunCalc.getTimes(date, lat, lon);
  return { sunrise: t.sunrise, sunset: t.sunset };
}
