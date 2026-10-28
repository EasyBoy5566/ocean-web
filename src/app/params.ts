// URL parameters, mostly for sharing a moment and for automated screenshots:
//   ?scene=ocean&time=18:40&date=2026-06-21&lat=25&lon=121.5&q=low&fps&shot&autostart
const q = new URLSearchParams(location.search);

const num = (k: string) => {
  const v = q.get(k);
  if (v === null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const quality = q.get('q');

export const params = {
  scene: q.get('scene'),
  time: q.get('time'),
  date: q.get('date'),
  lat: num('lat'),
  lon: num('lon'),
  quality: (quality === 'high' || quality === 'medium' || quality === 'low' ? quality : null) as 'high' | 'medium' | 'low' | null,
  autostart: q.has('autostart') || q.has('shot'),
  fps: q.has('fps'),
  shot: q.has('shot'),
  speed: num('speed'),
  /** Debug multiplier for fog and mist. */
  fog: num('fog'),
  /** Debug switches, comma separated: norefl, nosplash, noprops. */
  dbg: new Set((q.get('dbg') ?? '').split(',').filter(Boolean)),
};
