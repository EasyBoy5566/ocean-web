// Cloudflare Pages Function: approximate location from the visitor's IP.
// Cloudflare attaches geolocation to every request (request.cf); nothing is stored.
export function onRequestGet({ request }) {
  const cf = request.cf || {};
  const lat = Number(cf.latitude);
  const lon = Number(cf.longitude);
  const body = Number.isFinite(lat) && Number.isFinite(lon)
    ? { lat, lon, city: cf.city || null, country: cf.country || null, timezone: cf.timezone || null }
    : { error: 'unavailable' };
  return new Response(JSON.stringify(body), {
    status: Number.isFinite(lat) && Number.isFinite(lon) ? 200 : 404,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' },
  });
}
