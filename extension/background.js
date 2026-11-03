// Service worker: refresh scheduling, fetching, rules, notifications, badge, context menus, sync.

import * as db from './lib/db.js';
import { getSettings, getRules, saveSettings } from './lib/settings.js';
import { applyRules } from './lib/rules.js';
import { uid, postId, hash, normalizeUrl, pool, hostOf } from './lib/util.js';
import { mergeSubscriptions, writeSyncPayload, readSyncPayload, SYNC_META_KEY } from './lib/sync.js';
import { siteFeedCandidates } from './lib/sites.js';
import { CODE_VERSION } from './lib/version.js';

const READER_URL = chrome.runtime.getURL('reader.html');
const MIN_INTERVAL = 1;            // minutes
const MAX_BACKOFF_MIN = 24 * 60;

// ---------------------------------------------------------------------------
// Offscreen parsing
// ---------------------------------------------------------------------------

let creatingOffscreen = null;
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['DOM_PARSER'],
      justification: 'Parse RSS/Atom XML and HTML pages to find and read feeds.',
    }).catch((e) => { if (!/single offscreen/i.test(e.message)) throw e; })
      .finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function offscreen(msg, attempt = 0) {
  await ensureOffscreen();
  let res;
  try {
    res = await chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
  } catch (e) {
    if (attempt < 3) { await new Promise((r) => setTimeout(r, 150)); return offscreen(msg, attempt + 1); }
    throw e;
  }
  if (!res) {
    if (attempt < 3) { await new Promise((r) => setTimeout(r, 150)); return offscreen(msg, attempt + 1); }
    throw new Error('Parser unavailable');
  }
  if (!res.ok) throw new Error(res.error);
  return res;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function sniffCharset(buf, contentType) {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType || '')?.[1];
  if (fromHeader) return fromHeader;
  const bytes = new Uint8Array(buf, 0, Math.min(buf.byteLength, 1024));
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  const head = new TextDecoder('latin1').decode(bytes);
  return /<\?xml[^>]*encoding=["']([\w-]+)["']/i.exec(head)?.[1]
    || /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1]
    || 'utf-8';
}

function decodeBody(buf, contentType) {
  const charset = sniffCharset(buf, contentType);
  try { return new TextDecoder(charset).decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
}

async function httpGet(url, { etag, lastModified, force = false, timeout = 30000 } = {}) {
  const headers = {
    Accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.9, application/json;q=0.8, text/html;q=0.7, */*;q=0.5',
  };
  const u = new URL(url);
  if (u.username || u.password) {
    // Private feeds: https://user:pass@host/feed -> Basic auth header (fetch rejects credentials in URLs).
    headers.Authorization = 'Basic ' + btoa(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`);
    u.username = ''; u.password = '';
  }
  if (!force) {
    if (etag) headers['If-None-Match'] = etag;
    if (lastModified) headers['If-Modified-Since'] = lastModified;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(u.href, { headers, signal: ctrl.signal, cache: force ? 'no-cache' : 'default', credentials: 'include', redirect: 'follow' });
    if (res.status === 304) return { notModified: true };
    if (!res.ok) throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
    const contentType = res.headers.get('content-type') || '';
    const buf = await res.arrayBuffer();
    return {
      text: decodeBody(buf, contentType),
      url: res.url || u.href,
      contentType,
      etag: res.headers.get('etag') || '',
      lastModified: res.headers.get('last-modified') || '',
    };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Timed out');
    if (e instanceof TypeError) throw new Error(`Network error (${e.message})`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Broadcast helpers
// ---------------------------------------------------------------------------

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => { /* no open pages */ });
}

let refreshing = null;
let refreshProgress = { done: 0, total: 0 };

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

function feedIntervalMin(feed, settings) {
  const base = Math.max(MIN_INTERVAL, Number(feed.interval) || Number(settings.refreshMinutes) || 30);
  if (!feed.errorCount) return base;
  return Math.min(base * 2 ** Math.min(feed.errorCount, 8), MAX_BACKOFF_MIN);
}

async function refreshFeed(feedId, { force = false } = {}) {
  const feed = await db.getFeed(feedId);
  if (!feed) return { added: [], alerts: [] };
  const [settings, rules] = await Promise.all([getSettings(), getRules()]);
  const initial = !feed.lastSuccess;
  const now = Date.now();
  try {
    const res = await httpGet(feed.url, { etag: feed.etag, lastModified: feed.lastModified, force: force || initial });
    if (res.notModified) {
      await db.updateFeed(feedId, { lastFetched: now, lastError: '', errorCount: 0 });
      return { feed, added: [], alerts: [], initial };
    }
    const { feed: parsed } = await offscreen({ type: 'parseFeed', text: res.text, url: res.url });

    const byId = new Map();
    parsed.items.forEach((it, i) => {
      const id = postId(feed.id, it.guid);
      if (byId.has(id)) return;
      byId.set(id, {
        id, feedId: feed.id, guid: it.guid,
        title: it.title, link: it.link, author: it.author,
        published: it.published || now - i * 1000,
        fetchedAt: now,
        snippet: it.snippet, text: it.text, image: it.image, enclosures: it.enclosures,
        contentHtml: it.contentHtml,
        chash: hash(`${it.title}\u0000${it.contentHtml}`),
        read: 0, starred: 0, highlight: 0,
      });
    });
    const posts = [...byId.values()];
    const existing = await db.getExistingIds(posts.map((p) => p.id));
    const fresh = posts.filter((p) => !existing.has(p.id));
    // Snoozed feed: anything published before the snooze ends arrives already read.
    if (feed.snoozedUntil) for (const p of fresh) if (p.published < feed.snoozedUntil) p.read = 1;
    const { kept, alerts } = applyRules(rules, fresh);
    const keptIds = new Set(kept.map((p) => p.id));
    const added = await db.addPosts(posts.filter((p) => existing.has(p.id) || keptIds.has(p.id)), { dedupe: settings.hideDuplicates });

    await db.updateFeed(feedId, {
      title: parsed.title || feed.title,
      customTitle: feed.customTitle && feed.customTitle === parsed.title ? '' : feed.customTitle,
      siteUrl: parsed.siteUrl || feed.siteUrl || '',
      description: parsed.description || '',
      iconUrl: parsed.iconUrl || '',
      lastFetched: now, lastSuccess: now, lastError: '', errorCount: 0,
      etag: res.etag, lastModified: res.lastModified,
      ...(feed.snoozedUntil && now >= feed.snoozedUntil ? { snoozedUntil: 0 } : {}),
    });
    await db.prunePosts(feedId, {
      maxPosts: settings.maxPostsPerFeed,
      keepReadDays: settings.keepReadDays,
      protectIds: new Set(posts.map((p) => p.id)),
    });
    const addedById = new Map(added.map((p) => [p.id, p]));
    return { feed, added, alerts: alerts.filter((p) => addedById.has(p.id) && !addedById.get(p.id).dupOf), initial };
  } catch (e) {
    await db.updateFeed(feedId, { lastFetched: now, lastError: e.message || String(e), errorCount: (feed.errorCount || 0) + 1 });
    throw e;
  }
}

async function refreshAll({ feedIds = null, force = false, auto = false } = {}) {
  if (refreshing && auto) return { added: 0 };
  while (refreshing) await refreshing.catch(() => {});
  refreshing = (async () => {
    const settings = await getSettings();
    const now = Date.now();
    let feeds = await db.getAllFeeds();
    if (feedIds) feeds = feeds.filter((f) => feedIds.includes(f.id));
    else feeds = feeds.filter((f) => !f.paused && !(f.snoozedUntil > now));
    if (auto) feeds = feeds.filter((f) => now - (f.lastFetched || 0) >= feedIntervalMin(f, settings) * 60000 - 15000);
    if (!feeds.length) return { added: 0, errors: 0 };

    refreshProgress = { done: 0, total: feeds.length };
    broadcast({ type: 'refreshState', running: true, ...refreshProgress });
    const results = await pool(feeds, 6, async (f) => {
      try { return await refreshFeed(f.id, { force }); }
      finally {
        refreshProgress.done++;
        broadcast({ type: 'refreshState', running: true, ...refreshProgress });
      }
    });

    const toNotify = [];
    const alerts = [];
    let added = 0, errors = 0;
    results.forEach((r, i) => {
      if (!r.ok) { errors++; return; }
      const { added: a = [], alerts: al = [], initial } = r.value;
      added += a.length;
      if (initial) return;
      const feed = feeds[i];
      alerts.push(...al.map((p) => ({ ...p, feedTitle: feed.customTitle || feed.title })));
      if (settings.notifications && feed.notify !== false) {
        toNotify.push(...a.filter((p) => !p.read).map((p) => ({ ...p, feedTitle: feed.customTitle || feed.title })));
      }
    });
    await notifyNewPosts(toNotify, alerts);
    await chrome.storage.local.set({ lastRefreshAt: Date.now() });
    return { added, errors };
  })();
  try {
    return await refreshing;
  } finally {
    refreshing = null;
    await updateBadge();
    broadcast({ type: 'refreshState', running: false });
    broadcast({ type: 'postsUpdated' });
  }
}

// ---------------------------------------------------------------------------
// Notifications & badge
// ---------------------------------------------------------------------------

async function notifyNewPosts(posts, alerts) {
  const rules = alerts.length ? await getRules() : [];
  const alertIds = new Set(alerts.map((p) => p.id));
  for (const p of alerts.slice(0, 5)) {
    const rule = rules.find((r) => p.matchedRules?.includes(r.id) && r.actions.includes('notify'));
    createNotification(`post:${p.id}`, {
      title: `🔔 ${rule?.name || 'Keyword alert'} — ${p.feedTitle}`,
      message: p.title,
      contextMessage: hostOf(p.link),
    });
  }
  const rest = posts.filter((p) => !alertIds.has(p.id));
  if (!rest.length) return;
  if (rest.length <= 3) {
    for (const p of rest) {
      createNotification(`post:${p.id}`, { title: p.feedTitle || 'New post', message: p.title, contextMessage: hostOf(p.link) });
    }
  } else {
    const feeds = [...new Set(rest.map((p) => p.feedTitle))];
    createNotification(`summary:${Date.now()}`, {
      title: `${rest.length} new posts`,
      message: rest.slice(0, 3).map((p) => `• ${p.title}`).join('\n'),
      contextMessage: feeds.slice(0, 3).join(', ') + (feeds.length > 3 ? ` +${feeds.length - 3} more` : ''),
    });
  }
}

function createNotification(id, { title, message, contextMessage }) {
  const isPost = id.startsWith('post:');
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: String(title || '').slice(0, 120),
    message: String(message || '').slice(0, 300),
    contextMessage: contextMessage || '',
    priority: 0,
    buttons: isPost ? [{ title: 'Open' }, { title: 'Mark as read' }] : [{ title: 'Open reader' }],
  }, () => void chrome.runtime.lastError);
}

async function handleNotificationAction(id, button) {
  chrome.notifications.clear(id);
  if (id.startsWith('post:')) {
    const pid = id.slice(5);
    const post = await db.getPost(pid);
    if (post) {
      await db.setRead([pid], true);
      await updateBadge();
      broadcast({ type: 'postsUpdated' });
      if (button !== 1) {
        if (post.link) chrome.tabs.create({ url: post.link, active: true });
        else openReaderTab(`post=${encodeURIComponent(pid)}`);
      }
    }
  } else {
    openReaderTab();
  }
}

chrome.notifications.onClicked.addListener((id) => handleNotificationAction(id, -1));
chrome.notifications.onButtonClicked.addListener((id, idx) => handleNotificationAction(id, idx));

async function updateBadge() {
  const settings = await getSettings();
  let text = '';
  if (settings.badge === 'unread') {
    const n = await db.getTotalUnread();
    text = n ? (n > 999 ? '999+' : String(n)) : '';
  }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: '#0f766e' });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' });
}

// ---------------------------------------------------------------------------
// Subscribing & discovery
// ---------------------------------------------------------------------------

async function ensureFolder(name) {
  if (!name) return null;
  const folders = await db.getAllFolders();
  const found = folders.find((f) => f.name.toLowerCase() === name.toLowerCase());
  if (found) return found.id;
  const folder = { id: uid(), name, order: folders.length, collapsed: false };
  await db.putFolder(folder);
  return folder.id;
}

// `title` is a user-facing name from elsewhere (OPML, sync); it is kept as customTitle until the
// first fetch shows whether it differs from the feed's own title.
async function createFeed({ url, title = '', folderId = null, siteUrl = '', keepTitle = false }) {
  const norm = normalizeUrl(url);
  if (!norm) throw new Error('Invalid URL');
  const feeds = await db.getAllFeeds();
  const existing = feeds.find((f) => f.url === norm);
  if (existing) return { feed: existing, existed: true };
  const now = Date.now();
  const feed = {
    id: uid(), url: norm, title: title || hostOf(norm), customTitle: keepTitle ? title : '', siteUrl, description: '', iconUrl: '',
    folderId, addedAt: now, m: now, lastFetched: 0, lastSuccess: 0, lastError: '', errorCount: 0,
    etag: '', lastModified: '', notify: null, interval: null, paused: false, fullArticle: false,
  };
  await db.putFeed(feed);
  return { feed, existed: false };
}

async function subscribe({ url, title, folderId, folderName }) {
  const fid = folderId || (await ensureFolder(folderName));
  const { feed, existed } = await createFeed({ url, title, folderId: fid });
  if (!existed) {
    try { await refreshAll({ feedIds: [feed.id], force: true }); } catch { /* error is stored on the feed */ }
    scheduleSync();
  }
  return { feed: await db.getFeed(feed.id), existed };
}

async function tryParse(url, force = true) {
  const res = await httpGet(url, { force });
  const { feed } = await offscreen({ type: 'parseFeed', text: res.text, url: res.url });
  return { res, feed };
}

const COMMON_PATHS = ['/feed', '/rss', '/feed.xml', '/rss.xml', '/atom.xml', '/index.xml', '/feed.json', '/feeds/posts/default', '/?feed=rss2'];

async function checkCandidate(l) {
  const { feed } = await tryParse(l.url);
  return { url: l.url, title: feed.title || l.title, siteUrl: feed.siteUrl, count: feed.items.length, latest: feed.items[0]?.title || '' };
}

async function discover(rawUrl) {
  const url = normalizeUrl(rawUrl);
  if (!url) throw new Error('Please enter a valid URL');
  // 0) Feeds that popular sites (Reddit, GitHub, YouTube, Mastodon…) have but don't advertise.
  const special = siteFeedCandidates(url);
  const specialFound = special.length ? (await pool(special, 4, checkCandidate)).filter((r) => r.ok).map((r) => r.value) : [];
  let res;
  try {
    res = await httpGet(url, { force: true });
  } catch (e) {
    if (specialFound.length) return { candidates: specialFound };
    throw new Error(`Could not load ${hostOf(url) || url}: ${e.message}`);
  }
  // 1) The URL is itself a feed.
  try {
    const { feed } = await offscreen({ type: 'parseFeed', text: res.text, url: res.url });
    return { candidates: [{ url, title: feed.title, siteUrl: feed.siteUrl, count: feed.items.length, latest: feed.items[0]?.title || '' }] };
  } catch { /* not a feed, look for links */ }

  // 2) <link rel="alternate"> tags (or feed-looking anchors) in the HTML.
  let links = [];
  try { links = (await offscreen({ type: 'discoverLinks', html: res.text, url: res.url })).links; } catch { /* ignore */ }

  // 3) Common feed locations.
  if (!links.length && !specialFound.length) {
    const origin = new URL(res.url).origin;
    links = COMMON_PATHS.map((p) => ({ url: origin + p, title: '' }));
  }

  const checked = await pool(links.slice(0, 10), 4, checkCandidate);
  const seen = new Set();
  const candidates = [...specialFound, ...checked.filter((r) => r.ok).map((r) => r.value)].filter((c) => !seen.has(c.url) && seen.add(c.url));
  if (!candidates.length) throw new Error('No feed found at this address. Try the direct feed URL.');
  return { candidates };
}

// Injected into pages: must be self-contained.
function detectFeedsInPage() {
  const types = /application\/(rss|atom|rdf|feed)\+xml|application\/(feed\+)?json/i;
  const out = [];
  const seen = new Set();
  const ct = document.contentType || '';
  if (/(rss|atom|xml)/i.test(ct) && !/html/i.test(ct)) out.push({ url: location.href, title: document.title || 'This page', type: ct });
  for (const l of document.querySelectorAll('link[rel~="alternate" i][href]')) {
    const type = l.getAttribute('type') || '';
    if (!types.test(type) || seen.has(l.href)) continue;
    seen.add(l.href);
    out.push({ url: l.href, title: l.title || '', type });
  }
  return out;
}

async function detectInTab(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: detectFeedsInPage });
    return res?.result || [];
  } catch {
    return [];
  }
}

async function updateTabIndicator(tabId, url) {
  const settings = await getSettings();
  if (!settings.pageIndicator || !/^https?:/.test(url || '')) return;
  const found = await detectInTab(tabId);
  const subscribed = new Set((await db.getAllFeeds()).map((f) => f.url));
  const fresh = found.filter((f) => !subscribed.has(f.url));
  try {
    if (fresh.length) {
      await chrome.action.setIcon({ tabId, path: { 16: 'icons/icon-plus16.png', 32: 'icons/icon-plus32.png' } });
      await chrome.action.setTitle({ tabId, title: `Tributary — ${fresh.length} feed${fresh.length > 1 ? 's' : ''} available on this page` });
    } else {
      await chrome.action.setIcon({ tabId, path: { 16: 'icons/icon16.png', 32: 'icons/icon32.png' } });
      await chrome.action.setTitle({ tabId, title: 'Tributary RSS Reader' });
    }
  } catch { /* tab closed */ }
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete') updateTabIndicator(tabId, tab.url);
});

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

async function importFeeds(list) {
  let added = 0, skipped = 0;
  const newIds = [];
  for (const item of list) {
    try {
      const folderId = await ensureFolder(item.folder);
      const { feed, existed } = await createFeed({ url: item.url, title: item.title, folderId, siteUrl: item.siteUrl || '', keepTitle: true });
      if (existed) skipped++; else { added++; newIds.push(feed.id); }
    } catch {
      skipped++;
    }
  }
  if (newIds.length) {
    refreshAll({ feedIds: newIds }).catch(() => {});
    scheduleSync();
  }
  broadcast({ type: 'subscriptionsUpdated' });
  return { added, skipped };
}

// ---------------------------------------------------------------------------
// Reader tab
// ---------------------------------------------------------------------------

async function openReaderTab(hash = '') {
  const url = READER_URL + (hash ? `#${hash}` : '');
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
  const existing = contexts.find((c) => c.documentUrl?.startsWith(READER_URL) && c.tabId >= 0);
  if (existing) {
    await chrome.tabs.update(existing.tabId, { active: true, ...(hash ? { url } : {}) });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

async function applyOpenMode() {
  const { openMode } = await getSettings();
  await chrome.action.setPopup({ popup: openMode === 'tab' ? '' : 'popup.html' });
}

chrome.action.onClicked.addListener(() => openReaderTab());

// ---------------------------------------------------------------------------
// Sync (chrome.storage.sync)
// ---------------------------------------------------------------------------

async function deviceId() {
  let { deviceId: id } = await chrome.storage.local.get('deviceId');
  if (!id) { id = uid(); await chrome.storage.local.set({ deviceId: id }); }
  return id;
}

async function localSubscriptions() {
  const [feeds, folders] = await Promise.all([db.getAllFeeds(), db.getAllFolders()]);
  const names = new Map(folders.map((f) => [f.id, f.name]));
  return feeds.map((f) => ({ url: f.url, title: f.customTitle || f.title || '', folder: names.get(f.folderId) || '', m: f.m || f.addedAt || 0 }));
}

let syncTimer = null;
let syncing = null;
let appliedRemoteRulesAt = 0;

function scheduleSync(delay = 3000) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncNow().catch(() => {}); }, delay);
}

async function syncNow() {
  if (syncing) return syncing;
  syncing = (async () => {
    const settings = await getSettings();
    if (!settings.syncSubscriptions) return { skipped: true };
    const me = await deviceId();
    const { syncState = {}, rules = [], rulesUpdatedAt = 0 } = await chrome.storage.local.get(['syncState', 'rules', 'rulesUpdatedAt']);
    try {
      const local = await localSubscriptions();
      const remote = await readSyncPayload();
      let needPush = !remote;
      let addedIds = [];
      let finalList = local;

      if (remote) {
        const rp = remote.payload;
        const { toAdd, toRemove, toUpdate, result } = mergeSubscriptions(local, rp.feeds || [], syncState.base || []);
        const feeds = await db.getAllFeeds();
        for (const url of toRemove) {
          const f = feeds.find((x) => x.url === url);
          if (f) await db.deleteFeed(f.id);
        }
        for (const r of toAdd) {
          const folderId = await ensureFolder(r.folder);
          const { feed, existed } = await createFeed({ url: r.url, title: r.title, folderId, keepTitle: true });
          if (!existed) { addedIds.push(feed.id); await db.updateFeed(feed.id, { m: r.m || Date.now() }); }
        }
        for (const r of toUpdate) {
          const f = feeds.find((x) => x.url === r.url);
          if (!f) continue;
          const folderId = await ensureFolder(r.folder);
          await db.updateFeed(f.id, { customTitle: r.title && r.title !== f.title ? r.title : '', folderId, m: r.m });
        }
        if ((rp.rulesUpdatedAt || 0) > rulesUpdatedAt && Array.isArray(rp.rules)) {
          appliedRemoteRulesAt = rp.rulesUpdatedAt;
          await chrome.storage.local.set({ rules: rp.rules, rulesUpdatedAt: rp.rulesUpdatedAt });
        } else if (rulesUpdatedAt > (rp.rulesUpdatedAt || 0)) {
          needPush = true;
        }
        const remoteUrls = new Set((rp.feeds || []).map((f) => f.url));
        const remoteM = new Map((rp.feeds || []).map((f) => [f.url, f.m || 0]));
        needPush = needPush
          || result.length !== remoteUrls.size
          || result.some((f) => !remoteUrls.has(f.url) || (f.m || 0) > remoteM.get(f.url));
        finalList = result;
        if (toAdd.length || toRemove.length || toUpdate.length) broadcast({ type: 'subscriptionsUpdated' });
      }

      if (needPush) {
        const current = await chrome.storage.local.get(['rules', 'rulesUpdatedAt']);
        const payload = {
          v: 1, device: me, updatedAt: Date.now(),
          feeds: await localSubscriptions(),
          rules: current.rules || rules, rulesUpdatedAt: current.rulesUpdatedAt || rulesUpdatedAt,
        };
        const info = await writeSyncPayload(payload);
        finalList = payload.feeds;
        await chrome.storage.local.set({ syncState: { base: finalList.map((f) => f.url), lastSyncAt: Date.now(), lastPushAt: payload.updatedAt, bytes: info.bytes, lastError: '' } });
      } else {
        await chrome.storage.local.set({ syncState: { ...syncState, base: finalList.map((f) => f.url), lastSyncAt: Date.now(), lastError: '' } });
      }
      if (addedIds.length) refreshAll({ feedIds: addedIds }).catch(() => {});
      return { ok: true };
    } catch (e) {
      await chrome.storage.local.set({ syncState: { ...syncState, lastError: e.message || String(e), lastSyncAt: Date.now() } });
      throw e;
    }
  })();
  try { return await syncing; } finally { syncing = null; }
}

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'sync' && changes[SYNC_META_KEY]) {
    const meta = changes[SYNC_META_KEY].newValue;
    if (meta && meta.device !== (await deviceId())) scheduleSync(1000);
  }
  if (area === 'local') {
    if (changes.rules && changes.rulesUpdatedAt?.newValue !== appliedRemoteRulesAt) scheduleSync();
    if (changes.settings) {
      const prev = changes.settings.oldValue || {};
      const next = changes.settings.newValue || {};
      if (prev.openMode !== next.openMode) applyOpenMode();
      if (prev.badge !== next.badge) updateBadge();
      if (!prev.syncSubscriptions && next.syncSubscriptions) scheduleSync(500);
    }
  }
});

// ---------------------------------------------------------------------------
// Context menus & commands
// ---------------------------------------------------------------------------

function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'subscribe-page', title: 'Subscribe to this page in Tributary', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'subscribe-link', title: 'Subscribe to this link in Tributary', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'open-tab', title: 'Open reader in a tab', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'refresh-all', title: 'Refresh all feeds', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'mark-all-read', title: 'Mark everything as read', contexts: ['action'] });
  });
}

async function quickSubscribe(pageUrl, tabId) {
  let candidates = tabId != null ? await detectInTab(tabId) : [];
  if (!candidates.length) {
    try { candidates = (await discover(pageUrl)).candidates; }
    catch (e) {
      createNotification(`info:${Date.now()}`, { title: 'No feed found', message: e.message });
      return;
    }
  }
  if (candidates.length === 1) {
    const { feed, existed } = await subscribe({ url: candidates[0].url });
    broadcast({ type: 'subscriptionsUpdated' });
    createNotification(`info:${Date.now()}`, { title: existed ? 'Already subscribed' : 'Subscribed', message: feed.customTitle || feed.title });
    if (tabId != null) updateTabIndicator(tabId, pageUrl);
  } else {
    openReaderTab(`subscribe=${encodeURIComponent(pageUrl)}`);
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  switch (info.menuItemId) {
    case 'subscribe-page': return quickSubscribe(info.pageUrl || tab?.url, tab?.id);
    case 'subscribe-link': return quickSubscribe(info.linkUrl, null);
    case 'open-tab': return openReaderTab();
    case 'refresh-all': return refreshAll({ force: true });
    case 'mark-all-read': {
      const feeds = await db.getAllFeeds();
      await db.markAllRead(feeds.map((f) => f.id));
      await updateBadge();
      broadcast({ type: 'postsUpdated' });
      return undefined;
    }
    default: return undefined;
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'open-reader-tab') openReaderTab();
  if (command === 'refresh-all') refreshAll({ force: true });
});

// ---------------------------------------------------------------------------
// Message API for UI pages
// ---------------------------------------------------------------------------

const handlers = {
  async refresh({ feedIds, force = true }) {
    return refreshAll({ feedIds: feedIds || null, force });
  },
  async getStatus() {
    const { lastRefreshAt = 0 } = await chrome.storage.local.get('lastRefreshAt');
    return { running: !!refreshing, ...refreshProgress, lastRefreshAt, codeVersion: CODE_VERSION };
  },
  async discover({ url }) { return discover(url); },
  async subscribe(msg) { const r = await subscribe(msg); broadcast({ type: 'subscriptionsUpdated' }); return r; },
  async detectTab({ tabId }) { return { feeds: await detectInTab(tabId) }; },
  async importFeeds({ feeds }) { return importFeeds(feeds); },
  async unreadChanged() { await updateBadge(); return {}; },
  async subscriptionsChanged() { scheduleSync(); await updateBadge(); return {}; },
  async openReader({ hash }) { await openReaderTab(hash || ''); return {}; },
  async syncNow() { return syncNow(); },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen' || !handlers[msg.type]) return false;
  handlers[msg.type](msg).then(
    (result) => sendResponse({ ok: true, ...(result || {}) }),
    (e) => sendResponse({ ok: false, error: e?.message || String(e) }),
  );
  return true;
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function init() {
  const alarm = await chrome.alarms.get('refresh');
  if (!alarm) chrome.alarms.create('refresh', { periodInMinutes: 1, delayInMinutes: 0.1 });
  await applyOpenMode();
  await updateBadge();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'refresh') refreshAll({ auto: true }).catch(() => {});
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  setupContextMenus();
  await init();
  if (reason === 'install') {
    await saveSettings({});
    chrome.tabs.create({ url: chrome.runtime.getURL('reader.html#welcome') });
  }
  scheduleSync(2000);
});

chrome.runtime.onStartup.addListener(async () => {
  await init();
  scheduleSync(5000);
});
