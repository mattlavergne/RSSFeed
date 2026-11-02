// Reader UI — shared by the toolbar popup (body.popup) and the full-tab reader (body.tab).

import * as db from '../lib/db.js';
import { getSettings, saveSettings, applyTheme, onSettingsChanged } from '../lib/settings.js';
import { sanitizeHtml } from '../lib/sanitize.js';
import { escapeHtml, timeAgo, formatDate, hostOf, debounce, uid, iconImg, attachIconFallbacks, displayUrl } from '../lib/util.js';
import { icon, hydrateIcons } from './icons.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const isPopup = document.body.classList.contains('popup');
const PAGE = 50;

const STARTER_FEEDS = [
  { title: 'Hacker News (front page)', url: 'https://hnrss.org/frontpage' },
  { title: 'BBC News', url: 'https://feeds.bbci.co.uk/news/rss.xml' },
  { title: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
  { title: 'NASA Breaking News', url: 'https://www.nasa.gov/news-release/feed/' },
  { title: 'xkcd', url: 'https://xkcd.com/atom.xml' },
  { title: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index' },
];

const state = {
  settings: null,
  feeds: [],
  folders: [],
  counts: {},
  starredCount: 0,
  view: { type: 'all' },
  filter: 'unread',
  search: '',
  posts: [],
  hasMore: false,
  current: null,
  sidebarHidden: false,
  refreshing: false,
  fullArticle: new Map(), // postId -> 'loading' | {html} | {error}
  selected: new Map(),    // postId -> {id, link}; posts queued to open together (kept in session storage)
};

// ---------------------------------------------------------------------------
// Messaging helpers
// ---------------------------------------------------------------------------

async function send(type, data = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...data });
  if (!res) throw new Error('Background service did not respond');
  if (!res.ok) throw new Error(res.error || 'Unknown error');
  return res;
}

let toastTimer;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function confirmDialog(text, { ok = 'OK', danger = false, checkbox = null } = {}) {
  const dlg = $('#dlg-confirm');
  $('#confirm-text').textContent = text;
  const okBtn = $('#confirm-ok');
  okBtn.textContent = ok;
  okBtn.className = danger ? 'danger' : 'primary';
  const extra = $('#confirm-extra');
  extra.hidden = !checkbox;
  $('#confirm-check').checked = false;
  if (checkbox) $('span', extra).textContent = checkbox;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? { checked: $('#confirm-check').checked } : null), { once: true });
  });
}

function openLink(url, { active } = {}) {
  if (!url) return;
  const foreground = active ?? state.settings.linkTarget === 'foreground';
  chrome.tabs.create({ url, active: foreground });
}

const feedById = (id) => state.feeds.find((f) => f.id === id);
const feedTitle = (f) => (f ? f.customTitle || f.title || hostOf(f.url) : '');

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadFeeds() {
  const [feeds, folders] = await Promise.all([db.getAllFeeds(), db.getAllFolders()]);
  state.feeds = feeds.sort((a, b) => feedTitle(a).localeCompare(feedTitle(b), undefined, { sensitivity: 'base' }));
  state.folders = folders.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
  await loadCounts();
}

async function loadCounts() {
  const [counts, starred] = await Promise.all([db.getUnreadCounts(state.feeds.map((f) => f.id)), db.getStarredCount()]);
  state.counts = counts;
  state.starredCount = starred;
  renderSidebar();
}

function feedIdsInView(view = state.view) {
  if (view.type === 'feed') return [view.id];
  if (view.type === 'folder') return state.feeds.filter((f) => f.folderId === view.id).map((f) => f.id);
  return state.feeds.map((f) => f.id);
}

function currentQuery(extra = {}) {
  return {
    feedIds: feedIdsInView(),
    filter: state.view.type === 'starred' ? 'starred' : state.filter,
    search: state.search,
    sort: state.settings.sort,
    ...extra,
  };
}

async function loadPosts({ append = false } = {}) {
  const offset = append ? state.posts.length : 0;
  const { posts, hasMore } = await db.queryPosts(currentQuery({ offset, limit: PAGE }));
  state.posts = append ? state.posts.concat(posts) : posts;
  state.hasMore = hasMore;
  $('#new-pill').hidden = true;
  renderList();
  if (!append) $('#list-scroll').scrollTop = 0;
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function navItem({ cls = '', attrs = '', label, count, iconHtml, key, extra = '', title = '' }) {
  const active = viewKey(state.view) === key ? ' active' : '';
  const unread = count > 0 ? ' has-unread' : '';
  return `<div class="nav-item ${cls}${active}${unread}" ${attrs} data-key="${escapeHtml(key)}" title="${escapeHtml(title || label)}">
    ${iconHtml}<span class="label">${escapeHtml(label)}</span>${extra}<span class="count">${count > 0 ? count : ''}</span>
  </div>`;
}

const viewKey = (v) => (v.type === 'feed' || v.type === 'folder' ? `${v.type}:${v.id}` : v.type);

function parseKey(key) {
  const [type, id] = key.split(':');
  return id ? { type, id } : { type };
}

function feedRow(f) {
  const err = f.lastError ? `<span class="err" title="${escapeHtml(f.lastError)}">${icon('alert')}</span>` : '';
  const more = `<button class="icon-btn more" data-edit-feed="${f.id}" title="Edit feed">${icon('more')}</button>`;
  return navItem({
    cls: `feed${f.paused ? ' paused' : ''}`,
    attrs: `draggable="true" data-feed-id="${escapeHtml(f.id)}"`,
    key: `feed:${f.id}`,
    label: feedTitle(f),
    title: `${feedTitle(f)}\n${displayUrl(f.url)}${f.lastError ? `\n⚠ ${f.lastError}` : ''}`,
    count: state.counts[f.id] || 0,
    iconHtml: iconImg(f),
    extra: err + more,
  });
}

function renderSidebar() {
  const total = Object.values(state.counts).reduce((a, b) => a + b, 0);
  let html = navItem({ key: 'all', label: 'All articles', count: total, iconHtml: icon('inbox') });
  html += navItem({ key: 'starred', label: 'Starred', count: state.starredCount, iconHtml: icon('star') });
  html += `<div class="nav-heading"><span>Feeds</span><span>
    <button class="icon-btn" id="nav-new-folder" title="New folder">${icon('folderPlus')}</button>
    <button class="icon-btn" id="nav-add-feed" title="Add feed">${icon('plus')}</button></span></div>`;

  const folderIds = new Set(state.folders.map((f) => f.id));
  for (const folder of state.folders) {
    const feeds = state.feeds.filter((f) => f.folderId === folder.id);
    const count = feeds.reduce((a, f) => a + (state.counts[f.id] || 0), 0);
    html += navItem({
      cls: `folder${folder.collapsed ? ' collapsed' : ''}`,
      attrs: `data-folder-id="${escapeHtml(folder.id)}"`,
      key: `folder:${folder.id}`,
      label: folder.name,
      count,
      iconHtml: `<span class="chev-wrap" data-toggle-folder="${folder.id}">${icon('chevron', 'chev')}</span>`,
      extra: `<button class="icon-btn more" data-edit-folder="${folder.id}" title="Edit folder">${icon('more')}</button>`,
    });
    if (!folder.collapsed) html += `<div class="folder-children">${feeds.map(feedRow).join('')}</div>`;
  }
  html += '<div class="root-drop" data-root-drop="1">';
  html += state.feeds.filter((f) => !f.folderId || !folderIds.has(f.folderId)).map(feedRow).join('');
  html += '</div>';
  if (!state.feeds.length) html += '<div class="muted small" style="padding:8px 18px">No feeds yet.</div>';
  $('#sidebar').innerHTML = html;
  attachIconFallbacks($('#sidebar'));
  updateViewTitle();
  document.title = total ? `(${total}) Tributary` : 'Tributary';
}

function updateViewTitle() {
  const v = state.view;
  let title = 'All articles';
  if (v.type === 'starred') title = 'Starred';
  else if (v.type === 'folder') title = state.folders.find((f) => f.id === v.id)?.name || 'Folder';
  else if (v.type === 'feed') title = feedTitle(feedById(v.id)) || 'Feed';
  if (state.search) title = `Search: “${state.search}”`;
  $('#view-title').textContent = title;
  $$('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.filter === state.filter));
  $('.seg').hidden = v.type === 'starred';
}

async function selectView(view) {
  state.view = view;
  state.current = null;
  if (isNarrow()) $('#layout').classList.remove('reading');
  renderSidebar();
  renderArticle();
  await loadPosts();
}

// ---------------------------------------------------------------------------
// Post list
// ---------------------------------------------------------------------------

function postRow(p) {
  const feed = feedById(p.feedId);
  const showThumb = state.settings.showImages && state.settings.showThumbnails && p.image;
  const cls = ['post', p.read ? '' : 'unread', p.highlight ? 'highlight' : '', p.id === state.current ? 'active' : '', state.selected.has(p.id) ? 'selected' : ''].join(' ');
  return `<li class="${cls}" data-id="${escapeHtml(p.id)}">
    <span class="sel-mark">${icon('check')}</span>
    <span class="dot"></span>
    <div class="body">
      <div class="meta">${iconImg(feed)}<span class="feed-name">${escapeHtml(feedTitle(feed))}</span><span>·</span><span title="${escapeHtml(formatDate(p.published))}">${escapeHtml(timeAgo(p.published))}</span></div>
      <div class="title">${escapeHtml(p.title)}</div>
      ${p.snippet ? `<div class="snippet">${escapeHtml(p.snippet)}</div>` : ''}
    </div>
    ${showThumb ? `<img class="thumb" src="${escapeHtml(p.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
    <button class="icon-btn star-btn${p.starred ? ' on' : ''}" data-star="${escapeHtml(p.id)}" title="Star (s)">${icon('star')}</button>
  </li>`;
}

function renderList() {
  const list = $('#post-list');
  if (!state.feeds.length) {
    list.innerHTML = '';
    $('#list-footer').innerHTML = welcomeHtml();
    return;
  }
  list.innerHTML = state.posts.map(postRow).join('');
  attachIconFallbacks(list);
  $$('img.thumb', list).forEach((img) => img.addEventListener('error', () => { img.style.display = 'none'; }, { once: true }));
  let footer = '';
  if (state.hasMore) footer = '<button id="load-more">Load more</button>';
  else if (!state.posts.length) {
    const msg = state.search ? ['No results', 'Try a different search.']
      : state.view.type === 'starred' ? ['No starred posts', 'Press s or click the star on a post to save it here.']
        : state.filter === 'unread' ? ['All caught up', 'There are no unread posts here.'] : ['No posts', 'Nothing has been fetched for this view yet.'];
    footer = `<div class="empty">${icon(state.filter === 'unread' ? 'checkAll' : 'inbox', 'big')}<h3>${msg[0]}</h3><div>${msg[1]}</div>
      ${state.filter === 'unread' && state.view.type !== 'starred' && !state.search ? '<p><button id="show-all">Show all posts</button></p>' : ''}</div>`;
  }
  $('#list-footer').innerHTML = footer;
  setupScrollObserver();
}

function welcomeHtml() {
  return `<div class="welcome">
    <h2>Welcome to Tributary 👋</h2>
    <p class="muted">A free, private RSS reader. Everything is stored locally in your browser. Add a feed, import an OPML file from another reader, or start with one of these:</p>
    <div class="starter">${STARTER_FEEDS.map((f) => `<button data-starter="${escapeHtml(f.url)}">${escapeHtml(f.title)} ${icon('plus')}</button>`).join('')}</div>
    <p><button class="primary" id="welcome-add">${icon('plus')} Add a feed</button> <button id="welcome-import">Import OPML…</button></p>
    <p class="small muted">Tip: when a page you visit has a feed, the toolbar icon shows a green dot — click it to subscribe.</p>
  </div>`;
}

function updatePostRow(p) {
  const li = $(`#post-list li[data-id="${CSS.escape(p.id)}"]`);
  if (!li) return;
  li.classList.toggle('unread', !p.read);
  li.classList.toggle('highlight', !!p.highlight);
  li.classList.toggle('active', p.id === state.current);
  li.classList.toggle('selected', state.selected.has(p.id));
  $('.star-btn', li)?.classList.toggle('on', !!p.starred);
}

// ---------------------------------------------------------------------------
// Multi-select: queue posts (middle-click / Ctrl+click / x), then open them all at once
// ---------------------------------------------------------------------------

async function loadSelection() {
  try {
    const { selected = [] } = await chrome.storage.session.get('selected');
    state.selected = new Map(selected.map((s) => [s.id, s]));
  } catch { state.selected = new Map(); }
  renderSelectBar();
}

function saveSelection() {
  chrome.storage.session.set({ selected: [...state.selected.values()] }).catch(() => {});
}

function renderSelectBar() {
  const n = state.selected.size;
  $('#select-bar').hidden = n === 0;
  $('#select-count').textContent = `${n} selected`;
  $('#sel-open').textContent = n === 1 ? 'Open 1 post' : `Open ${n} posts`;
}

function toggleSelect(id) {
  const p = state.posts.find((x) => x.id === id);
  if (!p) return;
  if (state.selected.has(id)) state.selected.delete(id);
  else if (!p.link) { toast('This post has no link to open'); return; }
  else state.selected.set(id, { id, link: p.link });
  updatePostRow(p);
  saveSelection();
  renderSelectBar();
}

function clearSelection() {
  const ids = [...state.selected.keys()];
  state.selected.clear();
  for (const id of ids) { const p = state.posts.find((x) => x.id === id); if (p) updatePostRow(p); }
  saveSelection();
  renderSelectBar();
}

async function openSelected() {
  // Open in the order the posts appear in the list; anything selected in another view goes last.
  const order = new Map(state.posts.map((p, i) => [p.id, i]));
  const items = [...state.selected.values()].sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
  if (!items.length) return;
  if (items.length > 20 && !(await confirmDialog(`Open ${items.length} tabs at once?`, { ok: `Open ${items.length} tabs` }))) return;
  for (const it of items) await chrome.tabs.create({ url: it.link, active: false });
  clearSelection();
  await markRead(items.map((it) => it.id), true);
  toast(`Opened ${items.length} tab${items.length === 1 ? '' : 's'}`);
}

let scrollObserver = null;
let pendingScrollRead = new Set();
const flushScrollRead = debounce(async () => {
  const ids = [...pendingScrollRead];
  pendingScrollRead = new Set();
  if (ids.length) await markRead(ids, true);
}, 400);

function setupScrollObserver() {
  scrollObserver?.disconnect();
  if (!state.settings.markReadOnScroll) return;
  const root = $('#list-scroll');
  scrollObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting && e.boundingClientRect.bottom <= (e.rootBounds?.top ?? 0) + 1) {
        const p = state.posts.find((x) => x.id === e.target.dataset.id);
        if (p && !p.read) pendingScrollRead.add(p.id);
      }
    }
    flushScrollRead();
  }, { root, threshold: 0 });
  $$('#post-list li').forEach((li) => scrollObserver.observe(li));
}

// ---------------------------------------------------------------------------
// Post actions
// ---------------------------------------------------------------------------

async function markRead(ids, read) {
  const changed = await db.setRead(ids, read);
  for (const p of state.posts) if (ids.includes(p.id)) { p.read = read ? 1 : 0; updatePostRow(p); }
  if (changed) {
    await loadCounts();
    send('unreadChanged').catch(() => {});
  }
  if (state.current && ids.includes(state.current)) updateArticleToolbar();
}

async function toggleStar(id) {
  const p = state.posts.find((x) => x.id === id) || await db.getPost(id);
  if (!p) return;
  const next = !p.starred;
  await db.setStarred(id, next);
  p.starred = next ? 1 : 0;
  updatePostRow(p);
  if (id === state.current) updateArticleToolbar();
  state.starredCount += next ? 1 : -1;
  renderSidebar();
  toast(next ? 'Starred' : 'Removed from starred');
}

async function markAllInView() {
  const q = currentQuery();
  const label = $('#view-title').textContent;
  if (state.settings.markAllConfirm) {
    const ok = await confirmDialog(`Mark all posts in “${label}” as read?`, { ok: 'Mark as read', checkbox: 'Don’t ask again' });
    if (!ok) return;
    if (ok.checked) state.settings = await saveSettings({ markAllConfirm: false });
  }
  let changed;
  if (state.search || q.filter === 'starred') changed = await db.setRead(await db.queryAllIds({ ...q, filter: q.filter === 'starred' ? 'starred' : 'unread' }), true);
  else changed = await db.markAllRead(q.feedIds);
  state.posts.forEach((p) => { p.read = 1; updatePostRow(p); });
  await loadCounts();
  send('unreadChanged').catch(() => {});
  toast(`Marked ${changed} post${changed === 1 ? '' : 's'} as read`);
  if (state.filter === 'unread') await loadPosts();
}

// ---------------------------------------------------------------------------
// Article view
// ---------------------------------------------------------------------------

const isNarrow = () => isPopup || window.innerWidth < 1000;

async function openPost(id, { scroll = true } = {}) {
  const p = state.posts.find((x) => x.id === id) || await db.getPost(id);
  if (!p) return;
  const prev = state.current;
  state.current = id;
  if (prev) { const pp = state.posts.find((x) => x.id === prev); if (pp) updatePostRow(pp); }
  updatePostRow(p);
  if (scroll) $(`#post-list li[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
  $('#layout').classList.add('reading');
  await renderArticle(p);
  if (state.settings.markReadOnOpen && !p.read) await markRead([id], true);
}

function closeArticle() {
  state.current = null;
  $('#layout').classList.remove('reading');
  $$('#post-list li.active').forEach((li) => li.classList.remove('active'));
  renderArticle();
}

function articleToolbarHtml(p) {
  return `<div class="article-toolbar">
    <button class="icon-btn back-btn" data-act="back" title="Back to list (Esc)">${icon('back')}</button>
    <button class="icon-btn" data-act="prev" title="Previous (k)">${icon('up')}</button>
    <button class="icon-btn" data-act="next" title="Next (j)">${icon('down')}</button>
    <span class="spacer"></span>
    <button class="icon-btn star-btn${p.starred ? ' on' : ''}" data-act="star" title="Star (s)">${icon('star')}</button>
    <button class="icon-btn" data-act="read" title="${p.read ? 'Mark as unread (m)' : 'Mark as read (m)'}">${icon(p.read ? 'circle' : 'circleFilled')}</button>
    <button class="icon-btn" data-act="full" title="Load full article (f)">${icon('article')}</button>
    <button class="icon-btn" data-act="copy" title="Copy link (c)">${icon('link')}</button>
    <button class="icon-btn" data-act="open" title="Open original (o)">${icon('external')}</button>
  </div>`;
}

function updateArticleToolbar() {
  const p = state.posts.find((x) => x.id === state.current);
  const bar = $('#article-pane .article-toolbar');
  if (!p || !bar) return;
  bar.outerHTML = articleToolbarHtml(p);
}

async function renderArticle(p = null) {
  const pane = $('#article-pane');
  if (!p) {
    pane.innerHTML = isNarrow() ? '' : `<div class="empty" style="margin-top:15vh">${icon('rss', 'big')}<h3>Select a post</h3><div>Use <kbd>j</kbd> and <kbd>k</kbd> to move through posts.</div></div>`;
    return;
  }
  const feed = feedById(p.feedId);
  const content = await db.getContent(p.id);
  if (state.current !== p.id) return;
  const full = state.fullArticle.get(p.id) || (content?.fullHtml ? { html: content.fullHtml } : null);

  pane.innerHTML = `${articleToolbarHtml(p)}
    <div class="article">
      <div class="a-meta">
        ${iconImg(feed)}
        <a href="#" data-goto-feed="${escapeHtml(p.feedId)}">${escapeHtml(feedTitle(feed))}</a>
        ${p.author ? `<span>· ${escapeHtml(p.author)}</span>` : ''}
        <span>· ${escapeHtml(formatDate(p.published))}</span>
        ${p.highlight ? '<span class="tag">Rule match</span>' : ''}
      </div>
      <h1><a href="${escapeHtml(p.link || '#')}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.title)}</a></h1>
      <div class="content"></div>
      <div class="full-status"></div>
      <div class="enclosures"></div>
    </div>`;
  pane.scrollTop = 0;
  attachIconFallbacks(pane);

  const contentEl = $('.content', pane);
  const html = full?.html || content?.html || '';
  const frag = sanitizeHtml(html, { baseUrl: p.link || feed?.siteUrl || feed?.url, images: state.settings.showImages });
  if (!html.trim()) contentEl.innerHTML = `<p class="muted">This post has no content in the feed. ${p.link ? 'Press <kbd>f</kbd> to load the full article or <kbd>o</kbd> to open it.' : ''}</p>`;
  else contentEl.appendChild(frag);

  // Hero image if the content doesn't include one.
  if (state.settings.showImages && p.image && !contentEl.querySelector('img')) {
    const img = document.createElement('img');
    img.className = 'hero';
    img.src = p.image;
    img.referrerPolicy = 'no-referrer';
    img.alt = '';
    img.onerror = () => img.remove();
    contentEl.before(img);
  }

  const enc = $('.enclosures', pane);
  for (const e of p.enclosures || []) {
    if (/^audio/.test(e.type) || /\.(mp3|m4a|ogg|opus|wav|aac)(\?|$)/i.test(e.url)) {
      const a = document.createElement('audio');
      a.controls = true; a.preload = 'none'; a.src = e.url;
      enc.appendChild(a);
    } else if (/^video/.test(e.type) || /\.(mp4|webm|mov)(\?|$)/i.test(e.url)) {
      const v = document.createElement('video');
      v.controls = true; v.preload = 'none'; v.src = e.url;
      enc.appendChild(v);
    }
    const link = document.createElement('a');
    link.className = 'enc-link';
    link.href = e.url;
    link.textContent = `⬇ ${decodeURIComponent(e.url.split('/').pop().split('?')[0] || 'Attachment')}${e.length ? ` (${(e.length / 1048576).toFixed(1)} MB)` : ''}`;
    enc.appendChild(link);
  }

  const status = $('.full-status', pane);
  if (full?.html) status.textContent = 'Showing the full article.';
  else if (full?.error) status.textContent = `Couldn’t load full article: ${full.error}`;
  else if (full === 'loading') status.textContent = 'Loading full article…';

  if (!full && feed?.fullArticle && p.link) loadFullArticle(p.id);
}

async function loadFullArticle(id) {
  const p = state.posts.find((x) => x.id === id) || await db.getPost(id);
  if (!p?.link) return toast('This post has no link');
  const existing = state.fullArticle.get(id);
  if (existing === 'loading') return undefined;
  if (existing?.html) { // toggle back to feed content
    state.fullArticle.delete(id);
    await db.updateContent(id, { fullHtml: null });
    return state.current === id ? renderArticle(p) : undefined;
  }
  state.fullArticle.set(id, 'loading');
  if (state.current === id) $('#article-pane .full-status').textContent = 'Loading full article…';
  try {
    const res = await fetch(p.link, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const base = doc.createElement('base');
    base.href = res.url || p.link;
    doc.head.prepend(base);
    // Readability is loaded as a classic script (lib/vendor/Readability.js).
    const article = new window.Readability(doc, { charThreshold: 300 }).parse();
    if (!article?.content) throw new Error('No readable content found');
    state.fullArticle.set(id, { html: article.content });
    await db.updateContent(id, { fullHtml: article.content });
  } catch (e) {
    state.fullArticle.set(id, { error: e.message });
  }
  if (state.current === id) await renderArticle(p);
  return undefined;
}

function move(delta) {
  if (!state.posts.length) return;
  let idx = state.posts.findIndex((p) => p.id === state.current);
  idx = idx < 0 ? (delta > 0 ? 0 : state.posts.length - 1) : idx + delta;
  if (idx >= state.posts.length) {
    if (state.hasMore) loadPosts({ append: true }).then(() => move(0));
    return;
  }
  if (idx < 0) return;
  openPost(state.posts[idx].id);
}

function moveFeed(delta) {
  const keys = $$('#sidebar .nav-item').map((el) => el.dataset.key);
  const idx = keys.indexOf(viewKey(state.view));
  const next = keys[Math.max(0, Math.min(keys.length - 1, idx + delta))];
  if (next) selectView(parseKey(next));
}

async function copyLink(p) {
  if (!p?.link) return;
  await navigator.clipboard.writeText(p.link);
  toast('Link copied');
}

async function articleAction(act) {
  const p = state.posts.find((x) => x.id === state.current);
  switch (act) {
    case 'back': return closeArticle();
    case 'prev': return move(-1);
    case 'next': return move(1);
    case 'star': return p && toggleStar(p.id);
    case 'read': return p && markRead([p.id], !p.read);
    case 'full': return p && loadFullArticle(p.id);
    case 'copy': return copyLink(p);
    case 'open': return p && openLink(p.link);
    default: return undefined;
  }
}

// ---------------------------------------------------------------------------
// Add-feed dialog
// ---------------------------------------------------------------------------

function fillFolderSelect(select, selectedId = '') {
  select.innerHTML = `<option value="">No folder</option>${state.folders.map((f) => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join('')}<option value="__new">New folder…</option>`;
  select.value = selectedId || '';
}

async function resolveFolderChoice(select, input) {
  if (select.value !== '__new') return select.value || null;
  const name = input.value.trim();
  if (!name) return null;
  const existing = state.folders.find((f) => f.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing.id;
  const folder = { id: uid(), name, order: state.folders.length, collapsed: false };
  await db.putFolder(folder);
  state.folders.push(folder);
  return folder.id;
}

function renderCandidates(candidates) {
  const subscribed = new Set(state.feeds.map((f) => f.url));
  $('#add-results').innerHTML = candidates.map((c, i) => `<div class="candidate">
      ${icon('rss')}
      <div class="info">
        <div class="t">${escapeHtml(c.title || hostOf(c.url))}</div>
        <div class="u">${escapeHtml(c.url)}</div>
        ${c.latest ? `<div class="l">Latest: ${escapeHtml(c.latest)}${c.count ? ` · ${c.count} posts` : ''}</div>` : ''}
      </div>
      ${subscribed.has(c.url) ? '<span class="muted small">Subscribed ✓</span>' : `<button class="primary" data-subscribe="${i}">Subscribe</button>`}
    </div>`).join('');
  $('#add-results').candidates = candidates;
}

async function openAddDialog(prefill = '', { autoFind = false } = {}) {
  const dlg = $('#dlg-add');
  fillFolderSelect($('#add-folder'), state.view.type === 'folder' ? state.view.id : '');
  $('#add-new-folder').hidden = true;
  $('#add-new-folder').value = '';
  $('#add-url').value = prefill;
  $('#add-status').textContent = '';
  $('#add-results').innerHTML = '';
  if (!dlg.open) dlg.showModal();
  $('#add-url').focus();
  if (autoFind && prefill) return findFeeds();
  if (!prefill && isPopup) {
    // Offer the active tab's feeds right away.
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url && /^https?:/.test(tab.url)) {
      $('#add-url').value = tab.url;
      const { feeds } = await send('detectTab', { tabId: tab.id }).catch(() => ({ feeds: [] }));
      if (feeds.length) {
        $('#add-status').textContent = `Found ${feeds.length} feed${feeds.length > 1 ? 's' : ''} on this page:`;
        renderCandidates(feeds);
      }
    }
  }
  return undefined;
}

async function findFeeds() {
  const url = $('#add-url').value.trim();
  if (!url) return;
  $('#add-status').textContent = 'Looking for feeds…';
  $('#add-results').innerHTML = '';
  $('#add-find').disabled = true;
  try {
    const { candidates } = await send('discover', { url });
    $('#add-status').textContent = candidates.length > 1 ? `Found ${candidates.length} feeds:` : 'Found a feed:';
    renderCandidates(candidates);
  } catch (e) {
    $('#add-status').innerHTML = `<span class="error-text">${escapeHtml(e.message)}</span>`;
  } finally {
    $('#add-find').disabled = false;
  }
}

async function subscribeTo(candidate, button) {
  if (button) { button.disabled = true; button.textContent = 'Adding…'; }
  try {
    const folderId = await resolveFolderChoice($('#add-folder'), $('#add-new-folder'));
    const { feed, existed } = await send('subscribe', { url: candidate.url, title: candidate.title, folderId });
    await loadFeeds();
    if (button) button.outerHTML = '<span class="muted small">Subscribed ✓</span>';
    toast(existed ? 'Already subscribed' : `Subscribed to ${feedTitle(feed)}`);
    if (feed.lastError) toast(`Subscribed, but the first fetch failed: ${feed.lastError}`, 5000);
    send('subscriptionsChanged').catch(() => {});
    await selectView({ type: 'feed', id: feed.id });
    checkActiveTab();
    return feed;
  } catch (e) {
    if (button) { button.disabled = false; button.textContent = 'Subscribe'; }
    toast(`Error: ${e.message}`, 5000);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Feed / folder dialogs
// ---------------------------------------------------------------------------

let editingFeedId = null;
function openFeedDialog(id) {
  const f = feedById(id);
  if (!f) return;
  editingFeedId = id;
  $('#feed-title').value = f.customTitle || f.title || '';
  $('#feed-title').placeholder = f.title || '';
  $('#feed-url').value = f.url;
  fillFolderSelect($('#feed-folder'), f.folderId);
  $('#feed-new-folder').hidden = true;
  $('#feed-new-folder').value = '';
  $('#feed-interval').value = f.interval ? String(f.interval) : '';
  if (f.interval && !$('#feed-interval').value) $('#feed-interval').value = '';
  $('#feed-notify').value = f.notify === true ? 'on' : f.notify === false ? 'off' : '';
  $('#feed-full').checked = !!f.fullArticle;
  $('#feed-paused').checked = !!f.paused;
  $('#feed-info').innerHTML = [
    f.siteUrl ? `<div>Website: <a href="${escapeHtml(f.siteUrl)}" target="_blank" rel="noopener">${escapeHtml(f.siteUrl)}</a></div>` : '',
    `<div>Added ${escapeHtml(formatDate(f.addedAt))}</div>`,
    `<div>Last checked: ${f.lastFetched ? escapeHtml(formatDate(f.lastFetched)) : 'never'}${f.lastSuccess ? ` · last success ${escapeHtml(timeAgo(f.lastSuccess))} ago` : ''}</div>`,
    f.lastError ? `<div class="error-text">Last error: ${escapeHtml(f.lastError)}</div>` : '',
  ].join('');
  $('#dlg-feed').showModal();
}

async function saveFeedDialog() {
  const f = feedById(editingFeedId);
  if (!f) return;
  const url = $('#feed-url').value.trim();
  if (!url) { toast('Feed URL is required'); return; }
  const title = $('#feed-title').value.trim();
  const folderId = await resolveFolderChoice($('#feed-folder'), $('#feed-new-folder'));
  const notify = $('#feed-notify').value;
  const patch = {
    customTitle: title && title !== f.title ? title : '',
    url,
    folderId,
    interval: Number($('#feed-interval').value) || null,
    notify: notify === 'on' ? true : notify === 'off' ? false : null,
    fullArticle: $('#feed-full').checked,
    paused: $('#feed-paused').checked,
    m: Date.now(),
  };
  if (url !== f.url) Object.assign(patch, { etag: '', lastModified: '', lastError: '', errorCount: 0 });
  await db.updateFeed(f.id, patch);
  $('#dlg-feed').close();
  await loadFeeds();
  send('subscriptionsChanged').catch(() => {});
  if (url !== f.url) send('refresh', { feedIds: [f.id] }).catch(() => {});
  toast('Feed saved');
}

async function deleteFeedFlow(id) {
  const f = feedById(id);
  const ok = await confirmDialog(`Unsubscribe from “${feedTitle(f)}”? Its posts will be deleted (starred posts included).`, { ok: 'Unsubscribe', danger: true });
  if (!ok) return;
  await db.deleteFeed(id);
  $('#dlg-feed').close();
  if (state.view.type === 'feed' && state.view.id === id) state.view = { type: 'all' };
  await loadFeeds();
  await loadPosts();
  send('subscriptionsChanged').catch(() => {});
  toast('Unsubscribed');
}

let editingFolderId = null;
function openFolderDialog(id = null) {
  editingFolderId = id;
  const folder = state.folders.find((f) => f.id === id);
  $('#folder-dlg-title').textContent = folder ? 'Edit folder' : 'New folder';
  $('#folder-name').value = folder?.name || '';
  $('#folder-delete').hidden = !folder;
  $('#folder-markread').hidden = !folder;
  $('#dlg-folder').showModal();
  $('#folder-name').focus();
}

async function saveFolderDialog() {
  const name = $('#folder-name').value.trim();
  if (!name) return;
  const folder = state.folders.find((f) => f.id === editingFolderId);
  await db.putFolder(folder ? { ...folder, name } : { id: uid(), name, order: state.folders.length, collapsed: false });
  $('#dlg-folder').close();
  await loadFeeds();
  if (folder) touchFeedsInFolder(folder.id);
  send('subscriptionsChanged').catch(() => {});
}

async function touchFeedsInFolder(folderId) {
  const now = Date.now();
  for (const f of state.feeds.filter((x) => x.folderId === folderId)) await db.updateFeed(f.id, { m: now });
}

async function deleteFolderFlow() {
  const folder = state.folders.find((f) => f.id === editingFolderId);
  if (!folder) return;
  const ok = await confirmDialog(`Delete the folder “${folder.name}”? Its feeds will be moved to the top level.`, { ok: 'Delete folder', danger: true, checkbox: 'Also unsubscribe from the feeds inside it' });
  if (!ok) return;
  await touchFeedsInFolder(folder.id);
  await db.deleteFolder(folder.id, { deleteFeeds: ok.checked });
  $('#dlg-folder').close();
  if (state.view.type === 'folder' && state.view.id === folder.id) state.view = { type: 'all' };
  await loadFeeds();
  await loadPosts();
  send('subscriptionsChanged').catch(() => {});
}

// ---------------------------------------------------------------------------
// Active tab: discovery banner (popup only)
// ---------------------------------------------------------------------------

async function checkActiveTab() {
  if (!isPopup) return;
  const banner = $('#discover-banner');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/.test(tab.url || '')) { banner.hidden = true; return; }
    const { feeds } = await send('detectTab', { tabId: tab.id });
    const subscribed = new Set(state.feeds.map((f) => f.url));
    const fresh = feeds.filter((f) => !subscribed.has(f.url));
    if (!fresh.length) { banner.hidden = true; return; }
    banner.innerHTML = `${icon('rss')}<span class="grow">This page has ${fresh.length > 1 ? `${fresh.length} feeds` : 'a feed'}: <b>${escapeHtml(fresh[0].title || hostOf(fresh[0].url))}</b></span>
      ${fresh.length === 1 ? '<button class="primary" id="banner-sub">Subscribe</button>' : '<button class="primary" id="banner-choose">Choose…</button>'}
      <button class="icon-btn" id="banner-close" title="Dismiss">${icon('x')}</button>`;
    banner.hidden = false;
    banner.fresh = fresh;
  } catch {
    banner.hidden = true;
  }
}

// ---------------------------------------------------------------------------
// Refresh state
// ---------------------------------------------------------------------------

function setRefreshing(running, done = 0, total = 0) {
  state.refreshing = running;
  $('#btn-refresh').classList.toggle('spinning', running);
  $('#refresh-status').textContent = running && total > 1 ? `${done}/${total}` : '';
}

async function refreshAllFeeds(feedIds = null) {
  if (!state.feeds.length) return;
  setRefreshing(true);
  try {
    const { added = 0, errors = 0 } = await send('refresh', { feedIds });
    toast(added ? `${added} new post${added === 1 ? '' : 's'}` : errors ? `Up to date (${errors} feed${errors === 1 ? '' : 's'} failed)` : 'Up to date');
  } catch (e) {
    toast(`Refresh failed: ${e.message}`);
  } finally {
    setRefreshing(false);
  }
}

let reloadTimer = null;
async function onPostsUpdated() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    await loadFeeds();
    if (!state.posts.length) return loadPosts();
    const { posts } = await db.queryPosts(currentQuery({ offset: 0, limit: PAGE }));
    const known = new Set(state.posts.map((p) => p.id));
    const fresh = posts.filter((p) => !known.has(p.id));
    if (!fresh.length) return undefined;
    const atTop = $('#list-scroll').scrollTop < 10 && !state.current;
    if (atTop) return loadPosts();
    const pill = $('#new-pill');
    pill.textContent = `↑ ${fresh.length}${posts.length === PAGE && fresh.length === PAGE ? '+' : ''} new post${fresh.length === 1 ? '' : 's'}`;
    pill.hidden = false;
    return undefined;
  }, 250);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function bindEvents() {
  $('#btn-sidebar').addEventListener('click', () => {
    state.sidebarHidden = !state.sidebarHidden;
    $('#layout').classList.toggle('no-sidebar', state.sidebarHidden);
  });
  $('#btn-refresh').addEventListener('click', () => refreshAllFeeds());
  $('#btn-add').addEventListener('click', () => openAddDialog());
  $('#btn-markall').addEventListener('click', markAllInView);
  $('#btn-help').addEventListener('click', () => $('#dlg-help').showModal());
  $('#btn-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  const openTab = $('#btn-open-tab');
  if (isPopup) openTab.addEventListener('click', () => { send('openReader', { hash: state.current ? `post=${encodeURIComponent(state.current)}` : '' }); window.close(); });
  else openTab.hidden = true;

  $('#search').addEventListener('input', debounce((e) => {
    state.search = e.target.value.trim();
    state.current = null;
    updateViewTitle();
    loadPosts();
  }, 200));

  $$('.seg button').forEach((b) => b.addEventListener('click', () => setFilter(b.dataset.filter)));
  $('#new-pill').addEventListener('click', () => loadPosts());

  // Sidebar
  const sidebar = $('#sidebar');
  sidebar.addEventListener('click', async (e) => {
    const editFeed = e.target.closest('[data-edit-feed]');
    if (editFeed) { e.stopPropagation(); return openFeedDialog(editFeed.dataset.editFeed); }
    const editFolder = e.target.closest('[data-edit-folder]');
    if (editFolder) { e.stopPropagation(); return openFolderDialog(editFolder.dataset.editFolder); }
    const toggle = e.target.closest('[data-toggle-folder]');
    if (toggle) {
      e.stopPropagation();
      const folder = state.folders.find((f) => f.id === toggle.dataset.toggleFolder);
      folder.collapsed = !folder.collapsed;
      await db.putFolder(folder);
      return renderSidebar();
    }
    if (e.target.closest('#nav-new-folder')) return openFolderDialog(null);
    if (e.target.closest('#nav-add-feed')) return openAddDialog();
    const item = e.target.closest('.nav-item');
    if (item) return selectView(parseKey(item.dataset.key));
    return undefined;
  });

  // Drag feeds between folders
  sidebar.addEventListener('dragstart', (e) => {
    const row = e.target.closest('[data-feed-id]');
    if (row) e.dataTransfer.setData('text/x-feed-id', row.dataset.feedId);
  });
  const dropTarget = (e) => e.target.closest('[data-folder-id], [data-root-drop]');
  sidebar.addEventListener('dragover', (e) => {
    const t = dropTarget(e);
    if (!t || !e.dataTransfer.types.includes('text/x-feed-id')) return;
    e.preventDefault();
    $$('.drop-target', sidebar).forEach((x) => x !== t && x.classList.remove('drop-target'));
    t.classList.add('drop-target');
  });
  sidebar.addEventListener('dragleave', (e) => dropTarget(e)?.classList.remove('drop-target'));
  sidebar.addEventListener('drop', async (e) => {
    const t = dropTarget(e);
    const feedId = e.dataTransfer.getData('text/x-feed-id');
    if (!t || !feedId) return;
    e.preventDefault();
    await db.updateFeed(feedId, { folderId: t.dataset.folderId || null, m: Date.now() });
    await loadFeeds();
    send('subscriptionsChanged').catch(() => {});
  });

  // Post list
  $('#post-list').addEventListener('click', (e) => {
    const star = e.target.closest('[data-star]');
    if (star) { e.stopPropagation(); return toggleStar(star.dataset.star); }
    const li = e.target.closest('li[data-id]');
    if (li && (e.ctrlKey || e.metaKey)) { e.preventDefault(); return toggleSelect(li.dataset.id); }
    if (li) return openPost(li.dataset.id, { scroll: false });
    return undefined;
  });
  // Prevent the middle-button autoscroll cursor on the list.
  $('#post-list').addEventListener('mousedown', (e) => {
    if (e.button === 1 && e.target.closest('li[data-id]')) e.preventDefault();
  });
  $('#post-list').addEventListener('auxclick', (e) => {
    const li = e.target.closest('li[data-id]');
    if (e.button !== 1 || !li) return;
    e.preventDefault();
    if (state.settings.middleClick === 'open') {
      const p = state.posts.find((x) => x.id === li.dataset.id);
      if (p?.link) { openLink(p.link, { active: false }); markRead([p.id], true); }
    } else {
      toggleSelect(li.dataset.id);
    }
  });
  $('#sel-open').addEventListener('click', openSelected);
  $('#sel-clear').addEventListener('click', clearSelection);
  chrome.storage.onChanged.addListener((changes, area) => {
    // Keep popup and tab reader in step when both are open.
    if (area !== 'session' || !changes.selected) return;
    const next = new Map((changes.selected.newValue || []).map((s) => [s.id, s]));
    const same = next.size === state.selected.size && [...next.keys()].every((k) => state.selected.has(k));
    if (same) return;
    state.selected = next;
    state.posts.forEach(updatePostRow);
    renderSelectBar();
  });
  $('#list-footer').addEventListener('click', async (e) => {
    if (e.target.closest('#load-more')) return loadPosts({ append: true });
    if (e.target.closest('#show-all')) return setFilter('all');
    if (e.target.closest('#welcome-add')) return openAddDialog();
    if (e.target.closest('#welcome-import')) return chrome.tabs.create({ url: chrome.runtime.getURL('options.html#import') });
    const starter = e.target.closest('[data-starter]');
    if (starter) {
      const s = STARTER_FEEDS.find((f) => f.url === starter.dataset.starter);
      starter.disabled = true;
      $('#add-folder') && fillFolderSelect($('#add-folder'));
      await subscribeTo({ url: s.url, title: s.title }, null);
    }
    return undefined;
  });
  $('#list-scroll').addEventListener('scroll', () => {
    const el = $('#list-scroll');
    if (state.hasMore && el.scrollTop + el.clientHeight > el.scrollHeight - 200 && !el.loadingMore) {
      el.loadingMore = true;
      loadPosts({ append: true }).finally(() => { el.loadingMore = false; });
    }
  });

  // Article pane
  $('#article-pane').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (act) return articleAction(act.dataset.act);
    const gotoFeed = e.target.closest('[data-goto-feed]');
    if (gotoFeed) { e.preventDefault(); return selectView({ type: 'feed', id: gotoFeed.dataset.gotoFeed }); }
    const a = e.target.closest('a[href]');
    if (a) {
      const href = a.getAttribute('href');
      if (href.startsWith('#')) return undefined;
      e.preventDefault();
      return openLink(a.href, { active: e.shiftKey ? true : undefined });
    }
    return undefined;
  });
  $('#article-pane').addEventListener('auxclick', (e) => {
    const a = e.target.closest('a[href]');
    if (e.button === 1 && a && !a.getAttribute('href').startsWith('#')) { e.preventDefault(); openLink(a.href, { active: false }); }
  });

  // Add dialog
  const addForm = $('#dlg-add form');
  addForm.addEventListener('submit', (e) => {
    if (e.submitter?.value === 'cancel') return;
    e.preventDefault();
    findFeeds();
  });
  $('#add-find').addEventListener('click', findFeeds);
  $('#add-folder').addEventListener('change', (e) => { $('#add-new-folder').hidden = e.target.value !== '__new'; if (e.target.value === '__new') $('#add-new-folder').focus(); });
  $('#add-results').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-subscribe]');
    if (!btn) return;
    subscribeTo($('#add-results').candidates[Number(btn.dataset.subscribe)], btn);
  });

  // Feed dialog
  $('#feed-form').addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'save') return;
    e.preventDefault();
    saveFeedDialog();
  });
  $('#feed-folder').addEventListener('change', (e) => { $('#feed-new-folder').hidden = e.target.value !== '__new'; });
  $('#feed-delete').addEventListener('click', () => deleteFeedFlow(editingFeedId));
  $('#feed-markread').addEventListener('click', async () => {
    const n = await db.markAllRead([editingFeedId]);
    $('#dlg-feed').close();
    await loadCounts();
    send('unreadChanged').catch(() => {});
    toast(`Marked ${n} as read`);
    if (state.filter === 'unread') loadPosts();
  });
  $('#feed-refresh').addEventListener('click', async () => {
    $('#dlg-feed').close();
    await refreshAllFeeds([editingFeedId]);
  });

  // Folder dialog
  $('#dlg-folder form').addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'save') return;
    e.preventDefault();
    saveFolderDialog();
  });
  $('#folder-delete').addEventListener('click', deleteFolderFlow);
  $('#folder-markread').addEventListener('click', async () => {
    const ids = state.feeds.filter((f) => f.folderId === editingFolderId).map((f) => f.id);
    const n = await db.markAllRead(ids);
    $('#dlg-folder').close();
    await loadCounts();
    send('unreadChanged').catch(() => {});
    toast(`Marked ${n} as read`);
    if (state.filter === 'unread') loadPosts();
  });

  // Discover banner
  $('#discover-banner').addEventListener('click', async (e) => {
    const banner = $('#discover-banner');
    if (e.target.closest('#banner-close')) banner.hidden = true;
    if (e.target.closest('#banner-sub')) {
      fillFolderSelect($('#add-folder'));
      e.target.closest('#banner-sub').disabled = true;
      await subscribeTo(banner.fresh[0], null);
      banner.hidden = true;
    }
    if (e.target.closest('#banner-choose')) {
      await openAddDialog('-');
      $('#add-url').value = (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.url || '';
      $('#add-status').textContent = 'Feeds on this page:';
      renderCandidates(banner.fresh);
    }
  });

  document.addEventListener('keydown', onKey);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'postsUpdated') onPostsUpdated();
    else if (msg?.type === 'subscriptionsUpdated') loadFeeds().then(() => loadPosts());
    else if (msg?.type === 'refreshState') setRefreshing(msg.running, msg.done, msg.total);
    return false;
  });

  onSettingsChanged((s) => {
    const listAffecting = ['sort', 'showImages', 'showThumbnails', 'density', 'markReadOnScroll'].some((k) => s[k] !== state.settings[k]);
    state.settings = s;
    applyTheme(s);
    if (listAffecting) loadPosts();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(state.settings));
  window.addEventListener('hashchange', handleHash);
}

async function setFilter(filter) {
  state.filter = filter;
  updateViewTitle();
  await loadPosts();
}

function onKey(e) {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  if (document.querySelector('dialog[open]')) return;
  const typing = e.target.closest('input, textarea, select, [contenteditable]');
  if (typing) {
    if (e.key === 'Escape' && e.target.id === 'search') {
      e.target.value = '';
      state.search = '';
      e.target.blur();
      updateViewTitle();
      loadPosts();
    }
    return;
  }
  const p = state.posts.find((x) => x.id === state.current);
  const actions = {
    j: () => move(1), k: () => move(-1), n: () => move(1), p: () => move(-1),
    J: () => moveFeed(1), K: () => moveFeed(-1),
    o: () => p && openLink(p.link), Enter: () => p && openLink(p.link), v: () => p && openLink(p.link, { active: true }),
    x: () => p && toggleSelect(p.id),
    O: () => openSelected(),
    m: () => p && markRead([p.id], !p.read),
    s: () => p && toggleStar(p.id),
    f: () => p && loadFullArticle(p.id),
    c: () => copyLink(p),
    r: () => refreshAllFeeds(),
    a: () => openAddDialog(),
    A: () => markAllInView(),
    u: () => setFilter(state.filter === 'unread' ? 'all' : 'unread'),
    b: () => $('#btn-sidebar').click(),
    '/': () => $('#search').focus(),
    '?': () => $('#dlg-help').showModal(),
    Escape: () => (state.current ? closeArticle() : undefined),
  };
  const fn = actions[e.key];
  if (fn) { e.preventDefault(); fn(); }
}

async function handleHash() {
  const hash = decodeURIComponent(location.hash.slice(1));
  if (!hash) return;
  if (hash.startsWith('subscribe=')) {
    history.replaceState(null, '', location.pathname);
    await openAddDialog(hash.slice('subscribe='.length), { autoFind: true });
  } else if (hash.startsWith('post=')) {
    history.replaceState(null, '', location.pathname);
    const post = await db.getPost(hash.slice(5));
    if (post) {
      if (!state.posts.some((x) => x.id === post.id)) state.posts.unshift(post);
      renderList();
      openPost(post.id);
    }
  } else if (hash === 'welcome') {
    history.replaceState(null, '', location.pathname);
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  hydrateIcons();
  state.settings = await getSettings();
  applyTheme(state.settings);
  state.filter = state.settings.unreadOnly ? 'unread' : 'all';
  bindEvents();
  await loadSelection();
  await loadFeeds();
  await loadPosts();
  renderArticle();
  handleHash();
  checkActiveTab();
  send('getStatus').then((s) => setRefreshing(s.running, s.done, s.total)).catch(() => {});
}

init().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('afterbegin', `<div style="padding:12px;color:#c2410c">Failed to start: ${escapeHtml(e.message)}</div>`);
});
