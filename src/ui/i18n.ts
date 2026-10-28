export type Lang = 'zh' | 'en';

const dict = {
  title: { zh: '水境', en: 'Waterscapes' },
  subtitle: {
    zh: '隨著你頭頂真實的天空變化的海洋、湖泊與河流',
    en: 'An ocean, a lake and a river under your real sky',
  },
  enterSound: { zh: '開啟聲音進入', en: 'Enter with sound' },
  enterMuted: { zh: '靜音進入', en: 'Enter muted' },
  iosSilent: { zh: 'iPhone 請關閉側邊的靜音開關以聽到聲音', en: 'On iPhone, turn off silent mode to hear sound' },
  loading: { zh: '正在準備場景…', en: 'Preparing the scene…' },
  lake: { zh: '湖泊', en: 'Lake' },
  ocean: { zh: '海洋', en: 'Ocean' },
  river: { zh: '河流', en: 'River' },
  hint: {
    zh: '點水面激起水花　往上滑丟石頭　快速平甩能打水漂',
    en: 'Tap the water to splash · Swipe up to throw a stone · Flick fast and flat to skip it',
  },
  live: { zh: '現在', en: 'Live' },
  scrub: { zh: '拖動以改變時間', en: 'Drag to change the time' },
  sunrise: { zh: '日出', en: 'Sunrise' },
  sunset: { zh: '日落', en: 'Sunset' },
  settings: { zh: '設定', en: 'Settings' },
  close: { zh: '完成', en: 'Done' },
  quality: { zh: '畫質', en: 'Quality' },
  auto: { zh: '自動', en: 'Auto' },
  high: { zh: '高', en: 'High' },
  medium: { zh: '中', en: 'Medium' },
  low: { zh: '低', en: 'Low' },
  language: { zh: '語言', en: 'Language' },
  location: { zh: '位置', en: 'Location' },
  locPrecise: { zh: '使用精確位置', en: 'Use precise location' },
  locating: { zh: '定位中…', en: 'Locating…' },
  locDenied: { zh: '無法取得位置，維持目前設定', en: 'Location unavailable, keeping the current one' },
  locIp: { zh: '依網路位置估計', en: 'Estimated from your network' },
  locGps: { zh: '精確位置', en: 'Precise location' },
  locTz: { zh: '依時區估計', en: 'Estimated from your time zone' },
  locDefault: { zh: '預設：台北', en: 'Default: Taipei' },
  locParam: { zh: '由網址指定', en: 'Set by the link' },
  locNote: {
    zh: '位置只用來計算太陽、月亮與星星的方位，不會儲存或上傳。',
    en: 'Your location is only used to place the sun, moon and stars. It is never stored on a server.',
  },
  showFps: { zh: '顯示 FPS', en: 'Show FPS' },
  sound: { zh: '聲音', en: 'Sound' },
  on: { zh: '開', en: 'On' },
  off: { zh: '關', en: 'Off' },
  webgl: {
    zh: '你的瀏覽器不支援 WebGL 2，無法顯示這個場景。請改用新版的 Safari、Chrome 或 Edge。',
    en: 'Your browser does not support WebGL 2, which this scene needs. Please try a recent Safari, Chrome or Edge.',
  },
  about: {
    zh: '天空、光線與水面都即時運算，沒有預錄影片。',
    en: 'Sky, light and water are all computed live; nothing is pre-recorded.',
  },
} as const;

export type Key = keyof typeof dict;

const STORAGE_KEY = 'waterscape.lang';

function initial(): Lang {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'zh' || v === 'en') return v;
  } catch {
    /* ignore */
  }
  return /^zh/i.test(navigator.language) ? 'zh' : 'en';
}

let lang: Lang = initial();
const listeners = new Set<() => void>();

export function t(k: Key): string {
  return dict[k][lang];
}

export function getLang() {
  return lang;
}

export function setLang(l: Lang) {
  lang = l;
  document.documentElement.lang = l === 'zh' ? 'zh-Hant' : 'en';
  try {
    localStorage.setItem(STORAGE_KEY, l);
  } catch {
    /* ignore */
  }
  listeners.forEach((f) => f());
}

export function onLangChange(f: () => void) {
  listeners.add(f);
}
