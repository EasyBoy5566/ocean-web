import { params } from '../app/params';

export type LocationSource = 'param' | 'gps' | 'ip' | 'timezone' | 'default';

export interface GeoLocation {
  lat: number;
  lon: number;
  label?: string;
  source: LocationSource;
}

const STORAGE_KEY = 'waterscape.gps';
const GPS_MAX_AGE = 7 * 24 * 3600 * 1000;

// Representative coordinates for common IANA time zones (fallback only).
const TZ: Record<string, [number, number]> = {
  'Asia/Taipei': [25.03, 121.56], 'Asia/Tokyo': [35.68, 139.69], 'Asia/Seoul': [37.57, 126.98],
  'Asia/Shanghai': [31.23, 121.47], 'Asia/Hong_Kong': [22.32, 114.17], 'Asia/Macau': [22.2, 113.55],
  'Asia/Singapore': [1.35, 103.82], 'Asia/Kuala_Lumpur': [3.14, 101.69], 'Asia/Bangkok': [13.76, 100.5],
  'Asia/Ho_Chi_Minh': [10.82, 106.63], 'Asia/Saigon': [10.82, 106.63], 'Asia/Manila': [14.6, 120.98],
  'Asia/Jakarta': [-6.2, 106.85], 'Asia/Kolkata': [19.08, 72.88], 'Asia/Calcutta': [19.08, 72.88],
  'Asia/Dubai': [25.2, 55.27], 'Asia/Jerusalem': [31.77, 35.21], 'Asia/Karachi': [24.86, 67.0],
  'Asia/Dhaka': [23.81, 90.41], 'Asia/Kathmandu': [27.72, 85.32], 'Asia/Yangon': [16.84, 96.17],
  'Europe/London': [51.51, -0.13], 'Europe/Dublin': [53.35, -6.26], 'Europe/Lisbon': [38.72, -9.14],
  'Europe/Madrid': [40.42, -3.7], 'Europe/Paris': [48.86, 2.35], 'Europe/Brussels': [50.85, 4.35],
  'Europe/Amsterdam': [52.37, 4.9], 'Europe/Berlin': [52.52, 13.4], 'Europe/Zurich': [47.38, 8.54],
  'Europe/Rome': [41.9, 12.5], 'Europe/Vienna': [48.21, 16.37], 'Europe/Prague': [50.08, 14.44],
  'Europe/Warsaw': [52.23, 21.01], 'Europe/Stockholm': [59.33, 18.07], 'Europe/Oslo': [59.91, 10.75],
  'Europe/Copenhagen': [55.68, 12.57], 'Europe/Helsinki': [60.17, 24.94], 'Europe/Athens': [37.98, 23.73],
  'Europe/Istanbul': [41.01, 28.98], 'Europe/Kiev': [50.45, 30.52], 'Europe/Kyiv': [50.45, 30.52],
  'Europe/Moscow': [55.76, 37.62], 'Africa/Cairo': [30.04, 31.24], 'Africa/Lagos': [6.52, 3.38],
  'Africa/Nairobi': [-1.29, 36.82], 'Africa/Johannesburg': [-26.2, 28.05], 'Africa/Casablanca': [33.57, -7.59],
  'America/New_York': [40.71, -74.01], 'America/Toronto': [43.65, -79.38], 'America/Chicago': [41.88, -87.63],
  'America/Denver': [39.74, -104.99], 'America/Phoenix': [33.45, -112.07], 'America/Los_Angeles': [34.05, -118.24],
  'America/Vancouver': [49.28, -123.12], 'America/Anchorage': [61.22, -149.9], 'Pacific/Honolulu': [21.31, -157.86],
  'America/Mexico_City': [19.43, -99.13], 'America/Bogota': [4.71, -74.07], 'America/Lima': [-12.05, -77.04],
  'America/Santiago': [-33.45, -70.67], 'America/Sao_Paulo': [-23.55, -46.63], 'America/Argentina/Buenos_Aires': [-34.6, -58.38],
  'America/Buenos_Aires': [-34.6, -58.38], 'America/Halifax': [44.65, -63.58], 'Australia/Sydney': [-33.87, 151.21],
  'Australia/Melbourne': [-37.81, 144.96], 'Australia/Brisbane': [-27.47, 153.03], 'Australia/Adelaide': [-34.93, 138.6],
  'Australia/Perth': [-31.95, 115.86], 'Pacific/Auckland': [-36.85, 174.76], 'Atlantic/Reykjavik': [64.15, -21.94],
};

export const DEFAULT_LOCATION: GeoLocation = { lat: 25.03, lon: 121.56, label: 'Taipei', source: 'default' };

function fromTimezone(): GeoLocation | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const c = TZ[tz];
    if (c) return { lat: c[0], lon: c[1], label: tz.split('/').pop()?.replace(/_/g, ' '), source: 'timezone' };
    // Unknown zone: longitude from the UTC offset, a temperate latitude.
    const lon = (-new Date().getTimezoneOffset() / 60) * 15;
    return { lat: 30, lon, source: 'timezone' };
  } catch {
    return null;
  }
}

function readStoredGps(): GeoLocation | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { lat: number; lon: number; at: number };
    if (Date.now() - v.at > GPS_MAX_AGE) return null;
    return { lat: v.lat, lon: v.lon, source: 'gps' };
  } catch {
    return null;
  }
}

async function fromIp(timeoutMs: number): Promise<GeoLocation | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch('/api/geo', { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) return null;
    const j = (await res.json()) as { lat?: number; lon?: number; city?: string; country?: string };
    if (typeof j.lat !== 'number' || typeof j.lon !== 'number' || !isFinite(j.lat) || !isFinite(j.lon)) return null;
    return { lat: j.lat, lon: j.lon, label: j.city || j.country, source: 'ip' };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Best location available without prompting the user. */
export async function resolveLocation(): Promise<GeoLocation> {
  if (params.lat !== null && params.lon !== null) return { lat: params.lat, lon: params.lon, source: 'param' };
  const gps = readStoredGps();
  if (gps) return gps;
  const ip = await fromIp(1800);
  if (ip) return ip;
  return fromTimezone() ?? DEFAULT_LOCATION;
}

/** Asks the browser for a precise position (shows the permission prompt). */
export function requestPreciseLocation(): Promise<GeoLocation> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('unsupported'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc: GeoLocation = { lat: pos.coords.latitude, lon: pos.coords.longitude, source: 'gps' };
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ lat: loc.lat, lon: loc.lon, at: Date.now() }));
        } catch {
          /* storage unavailable: still use it for this session */
        }
        resolve(loc);
      },
      (err) => reject(err),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 3600 * 1000 },
    );
  });
}
