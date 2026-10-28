import { skyRadiance, transmittance, luminance, SUN_I, MS_BOOST, MOON_SCALE, type RGB } from '../src/env/atmosphere.ts';
const dir = (altDeg: number, azDeg: number) => {
  const a = altDeg * Math.PI / 180, z = azDeg * Math.PI / 180;
  return { x: Math.cos(a) * Math.sin(z), y: Math.sin(a), z: -Math.cos(a) * Math.cos(z) };
};
const f = (c: RGB) => c.map((v) => v.toExponential(2)).join(', ');
for (const sunAlt of [60, 30, 10, 3, 0, -2, -4, -6, -9, -12]) {
  const L = dir(sunAlt, 0);
  const zen = skyRadiance(20, dir(90, 0), L, SUN_I).map((v) => v * MS_BOOST) as RGB;
  const toward = skyRadiance(20, dir(5, 0), L, SUN_I).map((v) => v * MS_BOOST) as RGB;
  const away = skyRadiance(20, dir(5, 180), L, SUN_I).map((v) => v * MS_BOOST) as RGB;
  const T = transmittance(20, L);
  console.log(`sun ${sunAlt}: zenith[${f(zen)}] L=${luminance(zen).toExponential(2)} | toward5[${f(toward)}] | away5[${f(away)}] | T[${f(T)}]`);
}
const moonNight = skyRadiance(20, dir(90, 0), dir(40, 0), SUN_I * MOON_SCALE).map((v) => v * MS_BOOST) as RGB;
console.log('full moon zenith', f(moonNight), luminance(moonNight).toExponential(2));
