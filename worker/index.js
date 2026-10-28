// Cloudflare Worker: serves the built site from static assets and answers
// /api/geo with the visitor's approximate location. Cloudflare attaches
// geolocation to every request (request.cf); nothing is stored.

function geo(request) {
  const cf = request.cf || {};
  const lat = Number(cf.latitude);
  const lon = Number(cf.longitude);
  const ok = Number.isFinite(lat) && Number.isFinite(lon);
  const body = ok
    ? { lat, lon, city: cf.city || null, country: cf.country || null, timezone: cf.timezone || null }
    : { error: 'unavailable' };
  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 404,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/geo') return geo(request);
    // Only requests that match no static file reach the Worker.
    return env.ASSETS.fetch(request);
  },
};
