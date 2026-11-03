// End-to-end test: loads the unpacked extension in Chromium and drives it against local fixture feeds.
// Run: node tests/e2e.mjs   (HEADED=1 to watch, SCREENSHOTS=1 to refresh docs/screenshots)
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(root, 'extension');
const SHOTS = path.join(root, 'docs', 'screenshots');
const wantShots = !!process.env.SCREENSHOTS;

const results = [];
async function step(name, fn) {
  const t = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - t}ms)`);
  } catch (e) {
    results.push({ name, ok: false, e });
    console.log(`  ✗ ${name}\n    ${e.stack?.split('\n').slice(0, 4).join('\n    ')}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { timeout = 10000, interval = 150, msg = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${msg} (last: ${JSON.stringify(last)})`);
}

const srv = await startServer();
const B = srv.base;
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tributary-e2e-'));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: !process.env.HEADED,
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const pageErrors = [];
ctx.on('page', (p) => {
  p.on('pageerror', (e) => pageErrors.push(`${p.url()}: ${e.message}`));
});

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
const X = (p) => `chrome-extension://${extId}/${p}`;

// The install handler opens a welcome tab; wait for it and close it so the test tab stays in the
// foreground (background tabs get throttled animation frames, which slows Playwright's actions).
const welcome = ctx.pages().find((p) => p.url().includes('#welcome')) || await ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null);
const page = await ctx.newPage();
page.on('pageerror', (e) => pageErrors.push(`reader: ${e.message}`));
for (const p of ctx.pages()) if (p !== page) await p.close();
void welcome;
await page.goto(X('reader.html'));

const msg = (type, data = {}) => page.evaluate(([type, data]) => chrome.runtime.sendMessage({ type, ...data }), [type, data]);
const feedsByTitle = async () => Object.fromEntries((await page.evaluate(async () => (await import('/lib/db.js')).getAllFeeds())).map((f) => [f.title, f]));
const postsOf = (feedId) => page.evaluate(async (id) => {
  const db = await import('/lib/db.js');
  return (await db.queryPosts({ feedIds: [id], filter: 'all', limit: 100 })).posts;
}, feedId);

console.log(`Extension ${extId}, fixtures at ${B}`);

await step('welcome screen shows for a fresh install', async () => {
  await page.waitForSelector('.welcome');
  if (wantShots) {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, 'welcome.png') });
  }
});

await step('upgrades an existing version-1 database (back-fills duplicate keys)', async () => {
  const blank = await ctx.newPage();
  await blank.goto(X('icons/icon16.png'));
  const result = await blank.evaluate(async () => {
    const wait = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    await wait(indexedDB.deleteDatabase('tributary'));
    // Recreate the v1 schema exactly as version 1.0.0 shipped it, with one post in it.
    const open = indexedDB.open('tributary', 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      db.createObjectStore('feeds', { keyPath: 'id' });
      db.createObjectStore('folders', { keyPath: 'id' });
      const posts = db.createObjectStore('posts', { keyPath: 'id' });
      posts.createIndex('feedId', 'feedId');
      posts.createIndex('feedPublished', ['feedId', 'published']);
      posts.createIndex('feedRead', ['feedId', 'read']);
      posts.createIndex('read', 'read');
      posts.createIndex('starred', 'starred');
      db.createObjectStore('content', { keyPath: 'id' });
      posts.put({ id: 'old:1', feedId: 'old', title: 'An old post saved by version one of the app', link: 'https://www.old.example/story/?utm_source=x', published: 1, read: 0, starred: 0 });
    };
    const v1 = await wait(open);
    v1.close();
    const db = await import('/lib/db.js');
    const p = await db.getPost('old:1');
    const conn = await db.openDB();
    const names = [...conn.transaction('posts').objectStore('posts').indexNames];
    await wait(conn.transaction('posts', 'readwrite').objectStore('posts').delete('old:1'));
    return { version: conn.version, lkey: p.lkey, tkey: p.tkey, names };
  });
  await blank.close();
  await page.bringToFront();
  assert.equal(result.version, 2);
  assert.equal(result.lkey, 'old.example/story');
  assert.equal(result.tkey, 'an old post saved by version one of the app');
  assert.ok(result.names.includes('lkey') && result.names.includes('tkey'));
  await page.reload();
});

await step('discover: page with <link rel=alternate> tags', async () => {
  const r = await msg('discover', { url: `${B}/page.html` });
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.candidates.map((c) => c.title).sort(), ['Atom Example', 'Example & Co Blog']);
});

await step('discover: falls back to common feed paths', async () => {
  const r = await msg('discover', { url: `${B}/site/` });
  assert.ok(r.ok, r.error);
  assert.equal(r.candidates[0].title, 'Guessed Feed');
});

await step('discover: reports errors for unreachable pages', async () => {
  const r = await msg('discover', { url: `${B}/missing.html` });
  assert.equal(r.ok, false);
  assert.match(r.error, /HTTP 404/);
});

const subs = ['rss2.xml', 'atom.xml', 'feed.json', 'rdf.xml', 'latin1.xml', 'broken.xml', 'summary.xml', 'dynamic.xml'];
await step('subscribe to RSS 2.0, Atom, JSON Feed, RDF, latin-1, malformed, private feeds', async () => {
  for (const s of subs) {
    const r = await msg('subscribe', { url: `${B}/${s}` });
    assert.ok(r.ok, `${s}: ${r.error}`);
    assert.equal(r.feed.lastError, '', `${s}: ${r.feed.lastError}`);
  }
  const auth = await msg('subscribe', { url: B.replace('http://', 'http://user:secret@') + '/auth.xml' });
  assert.equal(auth.feed.lastError, '', auth.feed.lastError);
  const again = await msg('subscribe', { url: `${B}/rss2.xml` });
  assert.equal(again.existed, true);
});

let F;
await step('parsed feed metadata is correct', async () => {
  F = await feedsByTitle();
  for (const t of ['Example & Co Blog', 'Atom Example', 'JSON Feed Example', 'RDF Site', 'Café Latin1', 'Broken & Co', 'Private Feed', 'Summary Only', 'Dynamic Feed']) {
    assert.ok(F[t], `missing feed "${t}" — have ${Object.keys(F).join(', ')}`);
  }
  assert.equal(F['Example & Co Blog'].siteUrl, 'https://example.com/');
  assert.equal(F['Atom Example'].siteUrl, 'https://atom.example.org/');
});

await step('RSS 2.0 items: titles, authors, images, enclosures, fallbacks', async () => {
  const posts = await postsOf(F['Example & Co Blog'].id);
  assert.equal(posts.length, 3);
  const first = posts.find((p) => p.link === 'https://example.com/first');
  assert.equal(first.title, 'First post with bold title');
  assert.equal(first.author, 'Alice');
  assert.equal(first.image, 'https://example.com/thumb1.jpg');
  assert.equal(first.published, Date.parse('Mon, 02 Nov 2026 10:00:00 +0000'));
  const ep = posts.find((p) => p.title === 'Podcast episode');
  assert.equal(ep.enclosures[0].url, 'https://example.com/ep2.mp3');
  assert.equal(ep.enclosures[0].type, 'audio/mpeg');
  const untitled = posts.find((p) => p.link === 'https://example.com/untitled');
  assert.match(untitled.title, /^An item with no title/);
});

await step('Atom / JSON Feed / RDF / latin-1 / malformed items', async () => {
  const atom = await postsOf(F['Atom Example'].id);
  const one = atom.find((p) => p.link === 'https://atom.example.org/posts/one');
  assert.ok(one, JSON.stringify(atom.map((p) => p.link)));
  assert.equal(one.title, 'Atom <entry> one');
  assert.equal(one.author, 'Feed Author');
  assert.equal(atom.find((p) => p.title === 'Second entry').author, 'Bob');
  const content = await page.evaluate(async (id) => (await import('/lib/db.js')).getContent(id), one.id);
  assert.match(content.html, /XHTML <em>content<\/em>/);

  const json = await postsOf(F['JSON Feed Example'].id);
  assert.equal(json.length, 2);
  assert.equal(json.find((p) => p.link.endsWith('/2')).title, 'Text only item without a title');
  assert.equal(json.find((p) => p.link.endsWith('/2')).enclosures[0].type, 'video/mp4');
  assert.equal(json.find((p) => p.link.endsWith('/1')).image, 'https://json.example.net/1.png');

  const rdf = await postsOf(F['RDF Site'].id);
  assert.equal(rdf[0].title, 'RDF item A');
  assert.equal(rdf[0].published, Date.parse('2026-10-29T10:00:00Z'));

  const latin = await postsOf(F['Café Latin1'].id);
  assert.equal(latin[0].title, 'Crème brûlée & friends');

  const broken = await postsOf(F['Broken & Co'].id);
  assert.equal(broken[0].title, 'Tom & Jerry');
  assert.equal(broken[0].link, 'https://b.example/1?a=1&b=2');
});

await step('badge shows the unread count', async () => {
  const total = await page.evaluate(async () => (await import('/lib/db.js')).getTotalUnread());
  const badge = await page.evaluate(() => chrome.action.getBadgeText({}));
  assert.ok(total > 10);
  assert.equal(badge, String(total));
});

await step('conditional GET: unchanged feed returns 304 and is not an error', async () => {
  const before = srv.hits['/dynamic.xml'];
  const r = await msg('refresh', { feedIds: [F['Dynamic Feed'].id], force: false });
  assert.ok(r.ok, r.error);
  assert.equal(r.added, 0);
  assert.equal(srv.hits['/dynamic.xml'], before + 1);
  const f = (await feedsByTitle())['Dynamic Feed'];
  assert.equal(f.lastError, '');
});

await step('rules: keyword alert highlights + stars, filter hides spam', async () => {
  await page.evaluate(async () => {
    const { saveRules } = await import('/lib/settings.js');
    await saveRules([
      { id: 'r1', name: 'Kittens', enabled: true, field: 'title', op: 'contains', value: 'kitten', caseSensitive: false, feedIds: [], actions: ['notify', 'highlight', 'star'] },
      { id: 'r2', name: 'No spam', enabled: true, field: 'any', op: 'contains', value: 'spam', caseSensitive: false, feedIds: [], actions: ['delete'] },
    ]);
  });
  await fetch(`${B}/dynamic/add?title=${encodeURIComponent('Cute kitten pictures')}`);
  await fetch(`${B}/dynamic/add?title=${encodeURIComponent('Buy SPAM now')}`);
  const r = await msg('refresh', { feedIds: [F['Dynamic Feed'].id], force: false });
  assert.equal(r.added, 1);
  const posts = await postsOf(F['Dynamic Feed'].id);
  const kitten = posts.find((p) => p.title === 'Cute kitten pictures');
  assert.equal(kitten.highlight, 1);
  assert.equal(kitten.starred, 1);
  assert.ok(!posts.some((p) => /spam/i.test(p.title)));
  const notes = await until(async () => {
    const all = await page.evaluate(() => chrome.notifications.getAll());
    return Object.keys(all).length ? all : null;
  }, { msg: 'keyword-alert notification' });
  assert.ok(Object.keys(notes).includes(`post:${kitten.id}`), JSON.stringify(notes));
});

await step('auto-refresh alarm only fetches feeds that are due', async () => {
  const dyn = F['Dynamic Feed'].id;
  await page.evaluate(async (dyn) => {
    const db = await import('/lib/db.js');
    for (const f of await db.getAllFeeds()) await db.updateFeed(f.id, { lastFetched: f.id === dyn ? 0 : Date.now() });
  }, dyn);
  const before = { dyn: srv.hits['/dynamic.xml'], rss: srv.hits['/rss2.xml'] };
  await page.evaluate(() => chrome.alarms.create('refresh', { when: Date.now() + 50, periodInMinutes: 1 }));
  await until(() => srv.hits['/dynamic.xml'] > before.dyn, { timeout: 15000, msg: 'alarm-triggered fetch' });
  await sleep(500);
  assert.equal(srv.hits['/rss2.xml'], before.rss, 'feed that is not due was fetched');
});

await step('detects feeds advertised by an open web page', async () => {
  const web = await ctx.newPage();
  await web.goto(`${B}/page.html`);
  await page.bringToFront();
  const tabId = await page.evaluate(async (url) => (await chrome.tabs.query({ url })).at(0)?.id, `${B}/page.html`);
  assert.ok(tabId, 'tab not found');
  const r = await msg('detectTab', { tabId });
  assert.deepEqual(r.feeds.map((f) => f.title).sort(), ['Atom feed', 'Main RSS']);
  await web.close();
});

await step('reader UI: sidebar, list, sanitized article', async () => {
  await page.goto(X('reader.html'));
  await page.waitForSelector('#sidebar .nav-item.feed');
  const feedCount = await page.locator('#sidebar .nav-item.feed').count();
  assert.equal(feedCount, 9);
  await page.locator('#sidebar .nav-item.feed', { hasText: 'Example & Co Blog' }).click();
  await page.locator('#post-list li', { hasText: 'First post with bold title' }).click();
  await page.waitForSelector('#article-pane .content p');
  const html = await page.locator('#article-pane .content').innerHTML();
  assert.ok(!/<script/i.test(html), 'script tag leaked');
  assert.ok(!/onerror|onclick|style=/i.test(html), `attribute leaked: ${html}`);
  assert.ok(!/javascript:/i.test(html), 'javascript: url leaked');
  assert.ok(!/<iframe/i.test(html), 'iframe leaked');
  assert.ok(html.includes('src="https://example.com/img/a.png"'), 'relative image not resolved');
  assert.ok(html.includes('href="https://example.com/rel"'), 'relative link not resolved');
  assert.ok(!html.includes('tracker.example'), 'tracking pixel kept');
  assert.ok(html.includes('Open embedded content'), 'iframe placeholder missing');
  // Opening marks as read
  const read = await page.evaluate(async () => {
    const db = await import('/lib/db.js');
    const all = await db.getAllFeeds();
    const f = all.find((x) => x.title === 'Example & Co Blog');
    const { posts } = await db.queryPosts({ feedIds: [f.id], filter: 'all' });
    return posts.find((p) => p.link === 'https://example.com/first').read;
  });
  assert.equal(read, 1);
});

await step('keyboard: j/k navigation, s to star, m to toggle read', async () => {
  await page.locator('#sidebar .nav-item', { hasText: 'All articles' }).click();
  await page.locator('.seg button[data-filter="all"]').click();
  await page.waitForSelector('#post-list li');
  await page.keyboard.press('j');
  const first = await page.locator('#post-list li.active').getAttribute('data-id');
  await page.keyboard.press('j');
  const second = await page.locator('#post-list li.active').getAttribute('data-id');
  assert.notEqual(first, second);
  await page.keyboard.press('k');
  assert.equal(await page.locator('#post-list li.active').getAttribute('data-id'), first);
  const starredBefore = await page.evaluate(async () => (await import('/lib/db.js')).getStarredCount());
  await page.keyboard.press('s');
  await until(async () => (await page.evaluate(async () => (await import('/lib/db.js')).getStarredCount())) === starredBefore + 1, { msg: 'star' });
  await page.keyboard.press('m');
  await until(async () => (await page.locator('#post-list li.active.unread').count()) === 1, { msg: 'mark unread' });
});

await step('full article extraction (Readability)', async () => {
  await page.locator('#sidebar .nav-item.feed', { hasText: 'Summary Only' }).click();
  await page.locator('#post-list li', { hasText: 'Needs full text' }).click();
  await page.locator('[data-act="full"]').click();
  await until(async () => (await page.locator('#article-pane .content').innerText()).includes('FULLTEXT_MARKER'), { msg: 'full text' });
  assert.ok(!(await page.locator('#article-pane .content').innerText()).includes('Menu Home About'), 'boilerplate not stripped');
});

await step('search filters posts', async () => {
  await page.locator('#sidebar .nav-item', { hasText: 'All articles' }).click();
  await page.fill('#search', 'brûlée');
  await until(async () => (await page.locator('#post-list li').count()) === 1, { msg: 'search result' });
  await page.fill('#search', '');
  await page.locator('#search').press('Escape');
});

await step('mark all as read in a view', async () => {
  await page.locator('#sidebar .nav-item.feed', { hasText: 'JSON Feed Example' }).click();
  await page.locator('#btn-markall').click();
  await page.locator('#markall-ok').click();
  await until(async () => (await page.evaluate(async (id) => (await import('/lib/db.js')).getUnreadCounts([id]), F['JSON Feed Example'].id))[F['JSON Feed Example'].id] === 0, { msg: 'mark all read' });
});

await step('middle-click selects posts, then "Open all" opens them in background tabs', async () => {
  await fetch(`${B}/dynamic/add?title=${encodeURIComponent('Third dynamic post')}`);
  await msg('refresh', { feedIds: [F['Dynamic Feed'].id], force: false });
  await page.reload();
  await page.locator('#sidebar .nav-item.feed', { hasText: 'Dynamic Feed' }).click();
  await page.locator('.seg button[data-filter="all"]').click();
  const rows = page.locator('#post-list li');
  await until(async () => (await rows.count()) >= 3, { msg: 'dynamic posts' });
  const ids = await rows.evaluateAll((els) => els.map((el) => el.dataset.id));
  await rows.nth(0).click({ button: 'middle' });
  await rows.nth(1).click({ button: 'middle' });
  assert.equal(await page.locator('#select-count').innerText(), '2 selected');
  assert.equal(await page.locator('#post-list li.selected').count(), 2);
  assert.equal(await page.locator('#article-pane .article').count(), 0, 'middle-click should not open the article');

  // Toggle off/on, and Ctrl+click also selects.
  await rows.nth(1).click({ button: 'middle' });
  assert.equal(await page.locator('#select-count').innerText(), '1 selected');
  await rows.nth(1).click({ button: 'middle' });
  await rows.nth(2).click({ modifiers: ['Control'] });
  assert.equal(await page.locator('#select-count').innerText(), '3 selected');
  await rows.nth(2).click({ modifiers: ['Control'] });

  // Survives closing/reopening the reader (e.g. the popup closing).
  await page.reload();
  await page.locator('#sidebar .nav-item.feed', { hasText: 'Dynamic Feed' }).click();
  await page.locator('.seg button[data-filter="all"]').click();
  await until(async () => (await page.locator('#post-list li.selected').count()) === 2, { msg: 'selection restored' });
  assert.equal(await page.locator('#sel-open').innerText(), 'Open 2 posts');

  const opened = [];
  const onPage = (p) => opened.push(p);
  ctx.on('page', onPage);
  await page.locator('#sel-open').click();
  await until(() => opened.length === 2, { msg: 'two tabs opened' });
  ctx.off('page', onPage);
  await until(async () => opened.every((p) => p.url().includes('/article.html?')), { msg: 'tab urls' });
  const links = await page.evaluate(async (ids) => {
    const db = await import('/lib/db.js');
    return Promise.all(ids.map(async (id) => (await db.getPost(id)).link));
  }, ids.slice(0, 2));
  // Playwright may report new pages in any order, so check Chrome's actual tab positions.
  const tabOrder = await page.evaluate(async (links) => (await chrome.tabs.query({}))
    .filter((t) => links.includes(t.url || t.pendingUrl)).sort((a, b) => a.index - b.index).map((t) => t.url || t.pendingUrl), links);
  assert.deepEqual(tabOrder, links, 'tabs should open in list order');
  for (const p of opened) await p.close();
  await page.bringToFront();
  assert.equal(await page.locator('#select-bar').isVisible(), false);
  const reads = await page.evaluate(async (ids) => {
    const db = await import('/lib/db.js');
    return Promise.all(ids.map(async (id) => (await db.getPost(id)).read));
  }, ids.slice(0, 2));
  assert.deepEqual(reads, [1, 1]);

  // Keyboard: x selects the open post, Shift+O opens the batch.
  await rows.nth(2).click();
  await page.keyboard.press('x');
  assert.equal(await page.locator('#select-count').innerText(), '1 selected');
  const [tab] = await Promise.all([ctx.waitForEvent('page'), page.keyboard.press('Shift+O')]);
  await tab.close();
  await page.bringToFront();
});

await step('screenshots', async () => {
  if (!wantShots) return;
  await page.locator('#sidebar .nav-item', { hasText: 'All articles' }).click();
  await page.locator('.seg button[data-filter="all"]').click();
  await page.locator('#post-list li', { hasText: 'First post with bold title' }).click();
  await sleep(400);
  await page.screenshot({ path: path.join(SHOTS, 'reader.png') });
  await page.evaluate(async () => (await import('/lib/settings.js')).saveSettings({ theme: 'dark' }));
  await sleep(300);
  await page.screenshot({ path: path.join(SHOTS, 'reader-dark.png') });
  await page.evaluate(async () => (await import('/lib/settings.js')).saveSettings({ theme: 'system' }));
});

await step('popup layout renders in 780×580', async () => {
  const popup = await ctx.newPage();
  popup.on('pageerror', (e) => pageErrors.push(`popup: ${e.message}`));
  await popup.setViewportSize({ width: 780, height: 580 });
  await popup.goto(X('popup.html'));
  await popup.waitForSelector('#post-list li');
  await popup.locator('#post-list li').first().click();
  await popup.waitForSelector('#article-pane .article');
  assert.equal(await popup.locator('#list-pane').isVisible(), false, 'list should be hidden while reading in popup');
  if (wantShots) await popup.screenshot({ path: path.join(SHOTS, 'popup.png') });
  await popup.locator('[data-act="back"]').click();
  assert.equal(await popup.locator('#list-pane').isVisible(), true);
  await popup.close();
  await page.bringToFront();
});

await step('OPML import (nested folders) via options page', async () => {
  const opts = await ctx.newPage();
  opts.on('pageerror', (e) => pageErrors.push(`options: ${e.message}`));
  await opts.goto(X('options.html#import'));
  // Remove two feeds first so the import actually adds them.
  await page.evaluate(async () => {
    const db = await import('/lib/db.js');
    for (const f of await db.getAllFeeds()) if (['JSON Feed Example', 'RDF Site'].includes(f.title)) await db.deleteFeed(f.id);
  });
  const opml = (await (await fetch(`${B}/subs.opml`)).text());
  const tmp = path.join(userDataDir, 'subs.opml');
  fs.writeFileSync(tmp, opml);
  await opts.setInputFiles('#opml-file', tmp);
  await opts.waitForSelector('#import-status b');
  assert.match(await opts.locator('#import-status').innerText(), /Imported 2 feeds, skipped 1/);
  await until(async () => {
    const F2 = await feedsByTitle();
    return F2['JSON Feed Example']?.lastSuccess && F2['RDF Site']?.lastSuccess;
  }, { msg: 'imported feeds fetched' });
  const folders = await page.evaluate(async () => (await (await import('/lib/db.js')).getAllFolders()).map((f) => f.name).sort());
  assert.deepEqual(folders, ['Tech', 'Tech / Nested']);
  if (wantShots) {
    await opts.goto(X('options.html#feeds'));
    await opts.waitForSelector('#feeds-body tr');
    await opts.screenshot({ path: path.join(SHOTS, 'options-feeds.png') });
    await opts.goto(X('options.html#rules'));
    await opts.locator('#rule-new').click();
    await opts.screenshot({ path: path.join(SHOTS, 'options-rules.png') });
  }

  // Export OPML and re-parse it
  await opts.goto(X('options.html#import'));
  const [download] = await Promise.all([opts.waitForEvent('download'), opts.locator('#export-opml').click()]);
  const exported = fs.readFileSync(await download.path(), 'utf8');
  const parsed = await opts.evaluate(async (text) => (await import('/lib/feedparse.js')).parseOpml(text), exported);
  assert.equal(parsed.length, 9);
  assert.equal(parsed.find((f) => f.title === 'RDF Site').folder, 'Tech / Nested');

  // JSON backup export contains starred posts and rules
  const [dl2] = await Promise.all([opts.waitForEvent('download'), opts.locator('#export-json').click()]);
  const backup = JSON.parse(fs.readFileSync(await dl2.path(), 'utf8'));
  assert.equal(backup.feeds.length, 9);
  assert.equal(backup.rules.length, 2);
  assert.ok(backup.starred.length >= 2);
  await opts.close();
  await page.bringToFront();
});

await step('sync: pushes to chrome.storage.sync and applies remote additions', async () => {
  const r = await msg('syncNow');
  assert.ok(r.ok, r.error);
  const payload = await page.evaluate(async () => (await import('/lib/sync.js')).readSyncPayload());
  assert.equal(payload.payload.feeds.length, 9);
  // Simulate another device adding a feed.
  await page.evaluate(async (url) => {
    const sync = await import('/lib/sync.js');
    const { payload: p } = await sync.readSyncPayload();
    p.feeds.push({ url, title: 'From other device', folder: 'Synced', m: Date.now() });
    p.device = 'other-device';
    p.updatedAt = Date.now();
    await sync.writeSyncPayload(p);
  }, `${B}/redirect`);
  const synced = await until(async () => (await page.evaluate(async () => (await import('/lib/db.js')).getAllFeeds())).find((f) => f.url === `${B}/redirect` && f.lastSuccess), { timeout: 15000, msg: 'remote feed added and fetched' });
  assert.equal(synced.customTitle, 'From other device');
  const folders = await page.evaluate(async () => (await (await import('/lib/db.js')).getAllFolders()).map((f) => f.name));
  assert.ok(folders.includes('Synced'));
});

await step('batch: select-all unread, Shift+middle-click range, per-batch tab cap', async () => {
  const dyn = F['Dynamic Feed'].id;
  await page.evaluate(async (dyn) => {
    const db = await import('/lib/db.js');
    const { posts } = await db.queryPosts({ feedIds: [dyn], filter: 'all', limit: 100 });
    await db.setRead(posts.map((p) => p.id), false);
    (await import('/lib/settings.js')).saveSettings({ openBatchMax: 2 });
  }, dyn);
  await page.reload();
  await page.locator('#sidebar .nav-item.feed', { hasText: 'Dynamic Feed' }).click();
  await page.locator('.seg button[data-filter="all"]').click();
  const rows = page.locator('#post-list li');
  const n = await rows.count();
  assert.ok(n >= 3, `need 3+ posts, have ${n}`);

  await page.locator('#btn-select-all').click();
  await until(async () => (await page.locator('#select-count').innerText()) === `${n} selected`, { msg: 'select all' });
  assert.equal(await page.locator('#sel-open').innerText(), `Open 2 of ${n}`);
  const opened = [];
  const onPage = (p) => opened.push(p);
  ctx.on('page', onPage);
  await page.locator('#sel-open').click();
  await until(() => opened.length === 2, { msg: 'capped batch of 2' });
  await sleep(300);
  ctx.off('page', onPage);
  assert.equal(opened.length, 2);
  for (const p of opened) await p.close();
  await page.bringToFront();
  assert.equal(await page.locator('#select-count').innerText(), `${n - 2} selected`);
  await page.locator('#sel-clear').click();

  // Range: middle-click the first, Shift+middle-click the third → three selected.
  await rows.nth(0).click({ button: 'middle' });
  await rows.nth(2).click({ button: 'middle', modifiers: ['Shift'] });
  assert.equal(await page.locator('#select-count').innerText(), '3 selected');
  await page.locator('#sel-clear').click();
  await page.evaluate(async () => (await import('/lib/settings.js')).saveSettings({ openBatchMax: 10 }));
});

await step('catch-up: mark only posts older than a week as read', async () => {
  const dyn = F['Dynamic Feed'].id;
  const ids = await page.evaluate(async (dyn) => {
    const db = await import('/lib/db.js');
    const { posts } = await db.queryPosts({ feedIds: [dyn], filter: 'all', limit: 100 });
    await db.setRead(posts.map((p) => p.id), false);
    const old = posts.slice(0, 2).map((p) => p.id);
    for (const id of old) await db.updatePost(id, { published: Date.now() - 10 * 86400000 });
    for (const p of posts.slice(2)) await db.updatePost(p.id, { published: Date.now() - 3600000 });
    return { old, recent: posts.slice(2).map((p) => p.id) };
  }, dyn);
  await page.reload();
  await page.locator('#sidebar .nav-item.feed', { hasText: 'Dynamic Feed' }).click();
  await page.locator('#btn-markall').click();
  await page.locator('#dlg-markall input[value="604800000"]').check();
  await page.locator('#markall-ok').click();
  const state = await until(async () => {
    const r = await page.evaluate(async (all) => {
      const db = await import('/lib/db.js');
      return Promise.all(all.map(async (id) => (await db.getPost(id)).read));
    }, [...ids.old, ...ids.recent]);
    return r.slice(0, 2).every((x) => x === 1) ? r : null;
  }, { msg: 'old posts read' });
  assert.deepEqual(state.slice(2), ids.recent.map(() => 0), 'recent posts must stay unread');
});

await step('snooze: skipped by refreshes, posts during snooze arrive read, wakes up afterwards', async () => {
  const dyn = F['Dynamic Feed'].id;
  // Snooze through the feed dialog.
  await page.locator('#sidebar .nav-item.feed', { hasText: 'Dynamic Feed' }).hover();
  await page.locator(`#sidebar [data-edit-feed="${dyn}"]`).click();
  await page.locator('#feed-snooze').selectOption('7');
  assert.equal(await page.locator('#feed-snooze-opts').isVisible(), true);
  await page.locator('#feed-save').click();
  await until(async () => (await page.locator(`#sidebar [data-feed-id="${dyn}"] .zz`).count()) === 1, { msg: 'snooze icon' });
  const feed = await page.evaluate(async (id) => (await import('/lib/db.js')).getFeed(id), dyn);
  assert.ok(feed.snoozedUntil > Date.now() + 6 * 86400000);
  const unread = await page.evaluate(async (id) => (await import('/lib/db.js')).getUnreadCounts([id]), dyn);
  assert.equal(unread[dyn], 0, 'snoozing marks current unread as read');

  const hits = srv.hits['/dynamic.xml'];
  await msg('refresh', { force: false });
  assert.equal(srv.hits['/dynamic.xml'], hits, 'refresh-all must skip snoozed feeds');

  await fetch(`${B}/dynamic/add?title=${encodeURIComponent('Posted while snoozed')}`);
  await msg('refresh', { feedIds: [dyn], force: false });
  const during = await page.evaluate(async (id) => {
    const db = await import('/lib/db.js');
    return (await db.queryPosts({ feedIds: [id], filter: 'all', limit: 100 })).posts.find((p) => p.title === 'Posted while snoozed');
  }, dyn);
  assert.equal(during.read, 1);

  // Snooze over: new posts are unread again and the snooze is cleared.
  await page.evaluate(async (id) => (await import('/lib/db.js')).updateFeed(id, { snoozedUntil: Date.now() - 1000 }), dyn);
  await fetch(`${B}/dynamic/add?title=${encodeURIComponent('Posted after waking')}`);
  await msg('refresh', { feedIds: [dyn], force: false });
  const after = await page.evaluate(async (id) => {
    const db = await import('/lib/db.js');
    return { post: (await db.queryPosts({ feedIds: [id], filter: 'all', limit: 100 })).posts.find((p) => p.title === 'Posted after waking'), feed: await db.getFeed(id) };
  }, dyn);
  assert.equal(after.post.read, 0);
  assert.equal(after.feed.snoozedUntil, 0);
});

await step('duplicates: same link (tracking params) or same headline from another feed is marked read', async () => {
  const r = await msg('subscribe', { url: `${B}/dup.xml` });
  assert.ok(r.ok, r.error);
  const original = (await postsOf(F['Example & Co Blog'].id)).find((p) => p.link === 'https://example.com/first');
  const copies = await postsOf(r.feed.id);
  const byGuid = Object.fromEntries(copies.map((p) => [p.guid, p]));
  assert.equal(byGuid.c1.dupOf, original.id, 'link duplicate');
  assert.equal(byGuid.c1.read, 1);
  assert.equal(byGuid.c2.dupOf, original.id, 'headline duplicate');
  assert.equal(byGuid.c2.dupFeedId, F['Example & Co Blog'].id);
  assert.equal(byGuid.c3.dupOf, undefined);
  assert.equal(byGuid.c3.read, 0);
  await page.reload();
  await page.locator('#sidebar .nav-item.feed', { hasText: 'Syndicated Copies' }).click();
  await page.locator('.seg button[data-filter="all"]').click();
  await until(async () => (await page.locator('#post-list li.dup').count()) === 2, { msg: 'duplicate rows' });
  assert.match(await page.locator('#post-list li.dup .dup-note').first().innerText(), /also in Example & Co Blog/);
});

await step('feed health report flags failing feeds and can snooze from the table', async () => {
  const id = F['Café Latin1'].id;
  await page.evaluate(async (id) => (await import('/lib/db.js')).updateFeed(id, { lastError: 'HTTP 500 Internal Server Error', errorCount: 5 }), id);
  const opts = await ctx.newPage();
  opts.on('pageerror', (e) => pageErrors.push(`options: ${e.message}`));
  await opts.goto(X('options.html#health'));
  await opts.waitForSelector('#health-body tr[data-id]');
  const total = (await page.evaluate(async () => (await import('/lib/db.js')).getAllFeeds())).length;
  assert.equal(await opts.locator('#health-body tr[data-id]').count(), total);
  assert.equal(await opts.locator(`#health-body tr[data-id="${id}"] .badge.failing`).count(), 1);
  await opts.locator('#health-filter').selectOption('failing');
  assert.equal(await opts.locator('#health-body tr[data-id]').count(), 1);
  if (wantShots) {
    await opts.locator('#health-filter').selectOption('all');
    await opts.screenshot({ path: path.join(SHOTS, 'options-health.png') });
    await opts.locator('#health-filter').selectOption('failing');
  }
  await opts.locator(`#health-body tr[data-id="${id}"] .h-snooze`).click();
  await until(async () => (await opts.locator(`#health-body tr[data-id="${id}"] .badge.snoozed`).count()) === 1, { msg: 'snoozed badge' });
  await opts.close();
  await page.bringToFront();
});

await step('unsubscribe removes the feed and its posts', async () => {
  const id = (await feedsByTitle())['Broken & Co'].id;
  await page.evaluate(async (id) => (await import('/lib/db.js')).deleteFeed(id), id);
  assert.equal((await postsOf(id)).length, 0);
});

// Simulates `git pull` while the extension keeps running: install an older build, then replace its
// files on disk without reloading. Returns helpers bound to that browser.
async function withStaleInstall(patches, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tributary-stale-'));
  const extCopy = path.join(dir, 'extension');
  fs.cpSync(EXT, extCopy, { recursive: true });
  for (const [file, from, to] of patches) {
    const f = path.join(extCopy, file);
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(src.includes(from), `patch target missing in ${file}: ${from}`);
    fs.writeFileSync(f, src.replace(from, to));
  }
  const ctx2 = await chromium.launchPersistentContext(path.join(dir, 'profile'), {
    channel: 'chromium', headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${extCopy}`, `--load-extension=${extCopy}`],
  });
  try {
    let [sw2] = ctx2.serviceWorkers();
    if (!sw2) sw2 = await ctx2.waitForEvent('serviceworker');
    const id = new URL(sw2.url()).host;
    const p1 = await ctx2.newPage();
    await p1.goto(`chrome-extension://${id}/icons/icon16.png`);
    const send2 = (pg, type, data = {}) => pg.evaluate(([t, d]) => chrome.runtime.sendMessage({ type: t, ...d }), [type, data]);
    assert.equal((await send2(p1, 'subscribe', { url: `${B}/rss2.xml` })).ok, true, 'old build works before the pull');
    fs.cpSync(EXT, extCopy, { recursive: true }); // "git pull", no reload
    const p2 = await ctx2.newPage();
    await p2.goto(`chrome-extension://${id}/options.html#feeds`); // new page code upgrades the database
    await p2.waitForSelector('#feeds-body tr');
    await fn({ page: p2, send: (type, data) => send2(p2, type, data) });
  } finally {
    await ctx2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const OLD_DB = [
  ['lib/db.js', 'const DB_VERSION = 2;', 'const DB_VERSION = 1;'],
  ['lib/db.js', 'if (e.oldVersion < 2) {', 'if (false) {'],
  ['lib/db.js', '        if (dedupe) {', '        if (false) {'], // old builds had no duplicate check
  ['background.js', 'lastRefreshAt, codeVersion: CODE_VERSION };', 'lastRefreshAt };'],
];

await step('update without reloading (old build, like 1.1.0): pages show a "finish the update" banner', async () => {
  await withStaleInstall([
    ...OLD_DB,
    ['lib/db.js', "if (e?.name === 'VersionError') return openAt(undefined);", ''],
  ], async ({ page: p, send }) => {
    await p.waitForSelector('.update-banner', { timeout: 5000 });
    assert.match(await p.locator('.update-banner').innerText(), /reload/i);
    if (wantShots) await p.screenshot({ path: path.join(SHOTS, 'update-banner.png') });
    // This is the reported bug: the stale background can't open the upgraded database.
    const r = await send('subscribe', { url: `${B}/atom.xml` });
    assert.equal(r.ok, false);
    assert.match(r.error, /version/i);
  });
});

await step('update without reloading (future builds): stale background keeps working on the upgraded database', async () => {
  await withStaleInstall(OLD_DB, async ({ page: p, send }) => {
    await p.waitForSelector('.update-banner', { timeout: 5000 });
    const sub = await send('subscribe', { url: `${B}/atom.xml` });
    assert.equal(sub.ok, true, sub.error);
    const sync = await send('syncNow');
    assert.equal(sync.ok, true, sync.error);
    const titles = (await p.evaluate(async () => (await import('/lib/db.js')).getAllFeeds())).map((f) => f.title).sort();
    assert.deepEqual(titles, ['Atom Example', 'Example & Co Blog'], JSON.stringify(titles));
  });
});

await step('no update banner when the background is current', async () => {
  const opts = await ctx.newPage();
  await opts.goto(X('options.html#general'));
  await opts.waitForSelector('#tab-general.active');
  await sleep(500);
  assert.equal(await opts.locator('.update-banner').count(), 0);
  await opts.close();
  await page.bringToFront();
  assert.equal(await page.locator('.update-banner').count(), 0);
});

await step('no uncaught page errors', async () => {
  assert.deepEqual(pageErrors, []);
});

await ctx.close();
await srv.close();
fs.rmSync(userDataDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
