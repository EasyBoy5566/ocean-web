# 水境 Waterscapes

A real-time ocean, lake and river that follow the real sky above the viewer.
Tap the water to splash, swipe up to throw a stone, flick fast and flat to skip it.

隨著你頭頂真實天空變化的海洋、湖泊與河流。點水面激起水花，往上滑丟石頭，快速平甩可以打水漂。

## How it works

- **Sky**: single-scattering atmosphere (Rayleigh, Mie, ozone) rendered into a small
  sky-view lookup texture. The same model runs on the CPU to derive sunlight,
  moonlight, ambient light and exposure, so the sky and the lighting always agree.
- **Sun, moon, stars**: computed from the current time and the viewer's location
  (SunCalc, sidereal time for the star field, real moon phase from the sun direction).
- **Water**: planar reflections, Fresnel, GGX highlights, depth-based absorption,
  Gerstner swell (ocean) and flow maps (river). Interactive ripples come from a
  wave-equation simulation on the GPU, laid out on a grid warped like the camera's
  view so detail stays constant on screen.
- **Scenes**: every scene has a fixed camera; terrain and water meshes are fitted
  to that view, which acts as free level-of-detail.
- **Sound**: synthesised live with Web Audio (no audio files): surf, lapping water,
  a babbling river, birds, gulls, crickets, frogs, splashes.
- **Performance**: quality tier picked per device, with render resolution adapted
  continuously to hold the frame rate. The whole site is about 180 KB gzipped.

## Location and privacy

By default the location is estimated from the visitor's network by Cloudflare
(`functions/api/geo.js`), falling back to the time zone. Visitors can opt in to
precise location in Settings. The location is only used to place the sun, moon and
stars; it is not stored on any server.

## Develop

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check and build into dist/
```

Handy URL parameters: `?scene=ocean&time=18:40&date=2026-06-21&lat=25.03&lon=121.56&q=low&fps`
(`speed=60` runs the clock 60x faster).

`tools/shot.mjs` renders headless screenshots with Edge/Chrome for visual checks:

```bash
node tools/shot.mjs ocean-sunset "scene=ocean&time=17:10" 390 844 2
```

## Deploy (Cloudflare Pages)

Connect this repository in Cloudflare Pages with:

| Setting | Value |
|---|---|
| Framework preset | None (or Vite) |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Node version | from `.nvmrc` (22) |

The `functions/` directory is deployed automatically as Pages Functions.
