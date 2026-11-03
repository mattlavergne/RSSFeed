// Unit tests for the pure (browser-API-free) modules. Run: node --test tests/unit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRules, ruleMatches, validateRule } from '../extension/lib/rules.js';
import { mergeSubscriptions } from '../extension/lib/sync.js';
import { buildOpml } from '../extension/lib/opml.js';
import { hash, postId, normalizeUrl, timeAgo, pool, escapeHtml } from '../extension/lib/util.js';

const post = (o) => ({ id: 'p', feedId: 'f1', title: 'Hello World', text: 'Some body text about Rust and Go', author: 'Ann', link: 'https://x.com/a', ...o });
const rule = (o) => ({ id: 'r', enabled: true, field: 'any', op: 'contains', value: 'rust', caseSensitive: false, feedIds: [], actions: ['highlight'], ...o });

test('rules: contains matches any comma-separated keyword, case-insensitive', () => {
  assert.equal(ruleMatches(rule({ value: 'python, rust' }), post()), true);
  assert.equal(ruleMatches(rule({ value: 'python' }), post()), false);
  assert.equal(ruleMatches(rule({ value: 'RUST', caseSensitive: true }), post()), false);
});

test('rules: fields, ops, scope and disabled', () => {
  assert.equal(ruleMatches(rule({ field: 'title', value: 'rust' }), post()), false);
  assert.equal(ruleMatches(rule({ field: 'author', op: 'equals', value: 'ann' }), post()), true);
  assert.equal(ruleMatches(rule({ op: 'not_contains', value: 'java' }), post()), true);
  assert.equal(ruleMatches(rule({ op: 'regex', value: '\\bGo\\b' }), post()), true);
  assert.equal(ruleMatches(rule({ op: 'regex', value: '(' }), post()), false);
  assert.equal(ruleMatches(rule({ feedIds: ['other'] }), post()), false);
  assert.equal(ruleMatches(rule({ enabled: false }), post()), false);
  assert.equal(ruleMatches(rule({ field: 'link', value: 'x.com' }), post()), true);
});

test('rules: validate', () => {
  assert.equal(validateRule(rule({ value: '' })), 'Enter a keyword or pattern');
  assert.equal(validateRule(rule({ op: 'regex', value: '[' })), 'Invalid regular expression');
  assert.equal(validateRule(rule({ actions: [] })), 'Choose at least one action');
  assert.equal(validateRule(rule()), null);
});

test('rules: applyRules performs actions', () => {
  const posts = [post({ id: 'a' }), post({ id: 'b', title: 'Spam offer', text: '' }), post({ id: 'c', title: 'Neutral', text: '' })];
  const rules = [
    rule({ id: 'r1', actions: ['notify', 'star'] }),
    rule({ id: 'r2', field: 'title', value: 'spam', actions: ['delete'] }),
    rule({ id: 'r3', field: 'title', value: 'neutral', actions: ['markRead', 'highlight'] }),
  ];
  const { kept, alerts } = applyRules(rules, posts);
  assert.deepEqual(kept.map((p) => p.id), ['a', 'c']);
  assert.deepEqual(alerts.map((p) => p.id), ['a']);
  assert.equal(kept[0].starred, 1);
  assert.equal(kept[1].read, 1);
  assert.equal(kept[1].highlight, 1);
  assert.deepEqual(kept[0].matchedRules, ['r1']);
});

test('sync: three-way merge adds, removes and keeps local additions', () => {
  const S = (url, m = 1, folder = '', title = url) => ({ url, title, folder, m });
  const base = ['a', 'b', 'c'];
  const local = [S('a'), S('b'), S('local-new')];       // c deleted locally
  const remote = [S('a'), S('c'), S('remote-new')];     // b deleted remotely
  const r = mergeSubscriptions(local, remote, base);
  assert.deepEqual(r.toAdd.map((f) => f.url), ['remote-new']);
  assert.deepEqual(r.toRemove, ['b']);
  assert.deepEqual(r.result.map((f) => f.url).sort(), ['a', 'local-new', 'remote-new']);
});

test('sync: newer remote metadata wins, older is ignored', () => {
  const local = [{ url: 'a', title: 'Old', folder: '', m: 5 }, { url: 'b', title: 'Mine', folder: 'X', m: 9 }];
  const remote = [{ url: 'a', title: 'New', folder: 'Tech', m: 7 }, { url: 'b', title: 'Theirs', folder: '', m: 3 }];
  const r = mergeSubscriptions(local, remote, ['a', 'b']);
  assert.deepEqual(r.toUpdate.map((f) => f.url), ['a']);
  assert.equal(r.result.find((f) => f.url === 'b').title, 'Mine');
});

test('sync: first sync on a new device takes everything from remote', () => {
  const r = mergeSubscriptions([], [{ url: 'a' }, { url: 'b' }], []);
  assert.equal(r.toAdd.length, 2);
  assert.equal(r.toRemove.length, 0);
});

test('opml: export escapes, groups by folder and keeps unfoldered feeds', () => {
  const folders = [{ id: 'f1', name: 'Tech & Science', order: 0 }];
  const feeds = [
    { url: 'https://a.com/feed?x=1&y=2', title: 'A "quoted"', folderId: 'f1', siteUrl: 'https://a.com' },
    { url: 'https://b.com/rss', title: 'B', customTitle: 'Bee', folderId: null },
  ];
  const xml = buildOpml(feeds, folders);
  assert.match(xml, /<outline text="Tech &amp; Science" title="Tech &amp; Science">/);
  assert.match(xml, /xmlUrl="https:\/\/a.com\/feed\?x=1&amp;y=2"/);
  assert.match(xml, /text="A &quot;quoted&quot;"/);
  assert.match(xml, /text="Bee"/);
  assert.ok(xml.indexOf('Bee') > xml.indexOf('</outline>'));
});

test('util helpers', async () => {
  assert.equal(hash('abc'), hash('abc'));
  assert.notEqual(hash('abc'), hash('abd'));
  assert.equal(postId('f', 'g'), `f:${hash('g')}`);
  assert.equal(normalizeUrl('example.com/feed'), 'https://example.com/feed');
  assert.equal(normalizeUrl('feed://example.com/rss'), 'https://example.com/rss');
  assert.equal(normalizeUrl('feed:https://example.com/rss'), 'https://example.com/rss');
  assert.equal(normalizeUrl(''), '');
  assert.equal(timeAgo(Date.now() - 5 * 60000), '5m');
  assert.equal(escapeHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  let active = 0, max = 0;
  const res = await pool([1, 2, 3, 4, 5], 2, async (n) => { active++; max = Math.max(max, active); await new Promise((r) => setTimeout(r, 5)); active--; if (n === 3) throw new Error('x'); return n * 2; });
  assert.equal(max, 2);
  assert.deepEqual(res.map((r) => r.ok), [true, true, false, true, true]);
});

// ---------- duplicates, popular sites, feed health ----------
import { linkKey, titleKey } from '../extension/lib/util.js';
import { siteFeedCandidates } from '../extension/lib/sites.js';
import { assessFeeds } from '../extension/lib/health.js';

test('linkKey: same story URL matches despite tracking params, www, scheme, slash and hash', () => {
  const k = linkKey('https://www.example.com/news/story-1/?utm_source=rss&utm_medium=feed#comments');
  assert.equal(k, 'example.com/news/story-1');
  assert.equal(linkKey('http://example.com/news/story-1'), k);
  assert.equal(linkKey('https://example.com/news/story-1?fbclid=abc'), k);
  assert.notEqual(linkKey('https://example.com/news/story-2'), k);
  assert.equal(linkKey('https://example.com/item?id=1&b=2'), linkKey('https://example.com/item?b=2&id=1'));
  assert.notEqual(linkKey('https://news.ycombinator.com/item?id=1'), linkKey('https://news.ycombinator.com/item?id=2'));
  assert.equal(linkKey('https://example.com/'), '', 'homepage links are not distinctive');
  assert.equal(linkKey(''), '');
  assert.equal(linkKey('mailto:x@y.z'), '');
});

test('titleKey: ignores case, punctuation and accents; short titles are not compared', () => {
  const k = titleKey('Apple Announces “New” MacBook Pro — With M6 Chip!');
  assert.equal(k, titleKey('apple announces new macbook pro with m6 chip'));
  assert.equal(titleKey('Café opens in Zürich after long renovation'), titleKey('Cafe opens in Zurich after long renovation'));
  assert.equal(titleKey('Weekly update'), '');
});

test('siteFeedCandidates: maps popular sites to their hidden feeds', () => {
  const first = (u) => siteFeedCandidates(u)[0]?.url;
  assert.equal(first('https://www.reddit.com/r/programming/'), 'https://www.reddit.com/r/programming/.rss');
  assert.equal(first('https://old.reddit.com/r/rust/top/?t=week'), 'https://www.reddit.com/r/rust/top/.rss');
  assert.equal(first('https://reddit.com/u/spez'), 'https://www.reddit.com/user/spez/.rss');
  assert.deepEqual(siteFeedCandidates('https://github.com/mozilla/readability').map((c) => c.url), [
    'https://github.com/mozilla/readability/releases.atom',
    'https://github.com/mozilla/readability/tags.atom',
    'https://github.com/mozilla/readability/commits.atom',
  ]);
  assert.equal(first('https://github.com/torvalds'), 'https://github.com/torvalds.atom');
  assert.equal(first('https://www.youtube.com/playlist?list=PLx'), 'https://www.youtube.com/feeds/videos.xml?playlist_id=PLx');
  assert.equal(first('https://www.youtube.com/channel/UCabc'), 'https://www.youtube.com/feeds/videos.xml?channel_id=UCabc');
  assert.equal(first('https://mastodon.social/@Gargron'), 'https://mastodon.social/@Gargron.rss');
  assert.equal(first('https://bsky.app/profile/someone.bsky.social'), 'https://bsky.app/profile/someone.bsky.social/rss');
  assert.equal(first('https://medium.com/@someone'), 'https://medium.com/feed/@someone');
  assert.equal(first('https://writer.substack.com/p/a-post'), 'https://writer.substack.com/feed');
  assert.equal(first('https://artist.tumblr.com/'), 'https://artist.tumblr.com/rss');
  assert.deepEqual(siteFeedCandidates('https://example.com/blog'), []);
  assert.deepEqual(siteFeedCandidates('not a url'), []);
});

test('assessFeeds: flags failing, inactive and noisy feeds', () => {
  const DAY = 86400000, now = Date.UTC(2026, 10, 2);
  const feed = (id, o = {}) => ({ id, addedAt: now - 200 * DAY, lastSuccess: now, errorCount: 0, lastError: '', ...o });
  const feeds = [
    feed('quiet'), feed('normal1'), feed('normal2'), feed('firehose'),
    feed('broken', { lastError: 'HTTP 500', errorCount: 4 }),
    feed('blip', { lastError: 'Timed out', errorCount: 1, lastSuccess: now - DAY }),
    feed('new', { addedAt: now - 2 * DAY }),
  ];
  const stats = {
    quiet: { recent: 0, latest: now - 120 * DAY, total: 5, unread: 0 },
    normal1: { recent: 12, latest: now - DAY, total: 40, unread: 3, complete: true },
    normal2: { recent: 8, latest: now - DAY, total: 30, unread: 1, complete: true },
    // Only 4 days of history stored (the feed document holds its latest 60 items).
    firehose: { recent: 60, latest: now, total: 60, unread: 50, oldest: now - 4 * DAY, complete: false },
    broken: { recent: 4, latest: now - 5 * DAY, total: 10, unread: 0 },
    blip: { recent: 4, latest: now - DAY, total: 10, unread: 0 },
  };
  const rows = Object.fromEntries(assessFeeds(feeds, stats, { now }).map((r) => [r.feed.id, r]));
  assert.equal(rows.quiet.inactive, true);
  assert.equal(rows.normal1.inactive, false);
  assert.equal(rows.firehose.noisy, true);
  assert.ok(Math.abs(rows.firehose.perWeek - 105) < 0.01, `60 posts over 4 days ≈ 105/week, got ${rows.firehose.perWeek}`);
  assert.equal(rows.normal1.noisy, false);
  assert.equal(rows.broken.failing, true);
  assert.equal(rows.blip.failing, false, 'a single recent error is not "failing"');
  assert.equal(rows.new.inactive, false, 'brand-new feeds are not inactive');
  assert.ok(Math.abs(rows.normal1.perWeek - 2.8) < 0.01);
});

test('CODE_VERSION matches manifest.json version (bump both together)', async () => {
  const fs = await import('node:fs');
  const { CODE_VERSION } = await import('../extension/lib/version.js');
  const manifest = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(CODE_VERSION, manifest.version);
});
