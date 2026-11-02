// Small shared helpers usable from the service worker, offscreen document and UI pages.

export const uid = () => crypto.randomUUID();

// Fast, stable 53-bit string hash (cyrb53). Used to derive post ids.
export function hash(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export const postId = (feedId, guid) => `${feedId}:${hash(guid)}`;

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function resolveUrl(href, base) {
  if (!href) return '';
  try { return new URL(String(href).trim(), base || undefined).href; } catch { return ''; }
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export function normalizeUrl(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  if (u.startsWith('feed:')) u = u.replace(/^feed:(\/\/)?/, '');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
  try { return new URL(u).href; } catch { return ''; }
}

export function timeAgo(ts, now = Date.now()) {
  if (!ts) return '';
  const s = Math.round((now - ts) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Run async tasks with limited concurrency.
export async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = { ok: true, value: await worker(items[idx], idx) }; }
      catch (error) { results[idx] = { ok: false, error }; }
    }
  });
  await Promise.all(runners);
  return results;
}

export function faviconUrl(pageUrl, size = 32) {
  if (!pageUrl || typeof chrome === 'undefined' || !chrome.runtime?.getURL) return '';
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', pageUrl);
  u.searchParams.set('size', String(size));
  return u.href;
}

/** Hide the password of private feed URLs (https://user:pass@host) for display. */
export function displayUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '****';
    return u.href;
  } catch { return String(url || ''); }
}

/**
 * Candidate icon URLs for a feed, best first: the feed's own icon, the site's /favicon.ico,
 * then Chrome's local favicon cache. Requests go only to the feed's own site.
 */
export function feedIconCandidates(feed) {
  if (!feed) return [];
  const out = [];
  if (feed.iconUrl) out.push(feed.iconUrl);
  const site = feed.siteUrl || feed.url;
  try {
    const { protocol, host } = new URL(site);
    if (/^https?:$/.test(protocol)) out.push(`${protocol}//${host}/favicon.ico`);
  } catch { /* ignore */ }
  out.push(faviconUrl(site, 32));
  return out.filter(Boolean);
}

/** <img> markup that walks through fallbacks on error (see attachIconFallbacks). */
export function iconImg(feed, cls = 'fav') {
  const [first, ...rest] = feedIconCandidates(feed);
  if (!first) return `<span class="${cls}"></span>`;
  return `<img class="${cls}" src="${escapeHtml(first)}" data-fallbacks="${escapeHtml(rest.join(' '))}" alt="" referrerpolicy="no-referrer">`;
}

export function attachIconFallbacks(root) {
  root.querySelectorAll('img[data-fallbacks]').forEach((img) => {
    if (img.dataset.bound) return;
    img.dataset.bound = '1';
    img.addEventListener('error', () => {
      const list = (img.dataset.fallbacks || '').split(' ').filter(Boolean);
      if (!list.length) { img.style.visibility = 'hidden'; return; }
      img.dataset.fallbacks = list.slice(1).join(' ');
      img.src = list[0];
    });
    // Some sites answer /favicon.ico with a 1x1 or HTML page that still "loads".
    img.addEventListener('load', () => {
      if (img.naturalWidth <= 1 && img.dataset.fallbacks) img.dispatchEvent(new Event('error'));
    });
  });
}

export function downloadText(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function dateStamp(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

// ---------- duplicate detection keys ----------

const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|dclid|mc_cid|mc_eid|ref|ref_src|source|cmpid|ocid|_hsenc|_hsmi|igshid|si)$/i;

/** Canonical form of an article URL: no scheme/www/hash/tracking params/trailing slash. '' if unusable. */
export function linkKey(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return '';
    const params = [...u.searchParams].filter(([k]) => !TRACKING_PARAMS.test(k)).sort(([a], [b]) => a.localeCompare(b));
    const query = params.length ? `?${new URLSearchParams(params)}` : '';
    const path = u.pathname.replace(/\/+$/, '') || '/';
    if (path === '/' && !query) return ''; // a bare homepage link says nothing about the story
    return `${u.hostname.replace(/^www\./, '').toLowerCase()}${path}${query}`;
  } catch { return ''; }
}

/** Canonical form of a headline: lowercase, no punctuation/quotes. '' if too short to be distinctive. */
export function titleKey(title) {
  const t = String(title || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return t.length >= 25 ? t : '';
}
