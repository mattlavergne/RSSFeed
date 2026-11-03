import * as db from '../lib/db.js';
import { getSettings, saveSettings, applyTheme, getRules, saveRules, DEFAULT_SETTINGS } from '../lib/settings.js';
import { RULE_ACTIONS, RULE_FIELDS, RULE_OPS, validateRule, ruleMatches } from '../lib/rules.js';
import { buildOpml } from '../lib/opml.js';
import { assessFeeds } from '../lib/health.js';
import { isBackgroundStale, showUpdateBanner } from '../lib/version.js';
import { parseOpml } from '../lib/feedparse.js';
import { escapeHtml, timeAgo, formatDate, downloadText, dateStamp, uid, postId, hash, hostOf, iconImg, attachIconFallbacks, displayUrl } from '../lib/util.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

let settings;
let feeds = [];
let folders = [];
let rules = [];

async function send(type, data = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...data });
  if (!res?.ok) throw new Error(res?.error || 'No response from background');
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

const feedTitle = (f) => f.customTitle || f.title || hostOf(f.url);
const changed = () => send('subscriptionsChanged').catch(() => {});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function showTab(name) {
  if (!$(`#tab-${name}`)) name = 'general';
  if (name === 'health') loadHealth();
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
  $$('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === name));
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function bindSettings() {
  for (const el of $$('[data-setting]')) {
    const key = el.dataset.setting;
    const value = settings[key];
    if (el.type === 'checkbox') el.checked = !!value;
    else el.value = String(value);
    el.addEventListener('change', async () => {
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (el.dataset.type === 'number') {
        v = Number(v);
        if (!Number.isFinite(v)) v = DEFAULT_SETTINGS[key];
      }
      settings = await saveSettings({ [key]: v });
      applyTheme(settings);
      toast('Saved');
      if (key === 'syncSubscriptions') renderSyncStatus();
    });
  }
}

// ---------------------------------------------------------------------------
// Feeds
// ---------------------------------------------------------------------------

const INTERVALS = [['', 'Default'], ['5', '5 min'], ['15', '15 min'], ['30', '30 min'], ['60', '1 hour'], ['180', '3 hours'], ['360', '6 hours'], ['720', '12 hours'], ['1440', '1 day'], ['1', '1 min']];

async function loadData() {
  [feeds, folders] = await Promise.all([db.getAllFeeds(), db.getAllFolders()]);
  feeds.sort((a, b) => feedTitle(a).localeCompare(feedTitle(b), undefined, { sensitivity: 'base' }));
  folders.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
}

function folderOptions(selected) {
  return `<option value="">—</option>${folders.map((f) => `<option value="${escapeHtml(f.id)}"${f.id === selected ? ' selected' : ''}>${escapeHtml(f.name)}</option>`).join('')}`;
}

function feedStatus(f) {
  if (f.paused) return '<span class="status-paused">Paused</span>';
  if (f.snoozedUntil > Date.now()) return `<span class="status-paused" title="${escapeHtml(formatDate(f.snoozedUntil))}">Snoozed until ${escapeHtml(new Date(f.snoozedUntil).toLocaleDateString())}</span>`;
  if (f.lastError) return `<span class="status-err" title="${escapeHtml(f.lastError)}">⚠ ${escapeHtml(f.lastError)}</span>`;
  if (f.lastSuccess) return `<span class="status-ok" title="${escapeHtml(formatDate(f.lastSuccess))}">Updated ${escapeHtml(timeAgo(f.lastSuccess))}</span>`;
  return '<span class="status-ok">Pending</span>';
}

function renderFeeds() {
  const q = $('#feed-filter').value.trim().toLowerCase();
  const visible = feeds.filter((f) => !q || `${feedTitle(f)} ${f.url}`.toLowerCase().includes(q));
  $('#feeds-body').innerHTML = visible.map((f) => `<tr data-id="${escapeHtml(f.id)}">
    <td><input type="checkbox" class="sel"></td>
    <td>
      <div class="title-cell">${iconImg(f, 'fav')}<input type="text" class="f-title" value="${escapeHtml(feedTitle(f))}" title="Rename"></div>
      <div class="url" title="${escapeHtml(displayUrl(f.url))}">${escapeHtml(displayUrl(f.url))}</div>
    </td>
    <td><select class="f-folder">${folderOptions(f.folderId)}</select></td>
    <td><select class="f-interval">${INTERVALS.map(([v, l]) => `<option value="${v}"${String(f.interval || '') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></td>
    <td><select class="f-notify"><option value="">Default</option><option value="on"${f.notify === true ? ' selected' : ''}>On</option><option value="off"${f.notify === false ? ' selected' : ''}>Off</option></select></td>
    <td>${feedStatus(f)}</td>
    <td class="row-actions">
      <button class="f-pause" title="${f.paused ? 'Resume' : 'Pause'} updates">${f.paused ? 'Resume' : 'Pause'}</button>
      <button class="f-refresh">Refresh</button>
      <button class="f-delete danger">✕</button>
    </td>
  </tr>`).join('');
  attachIconFallbacks($('#feeds-body'));
  const errors = feeds.filter((f) => f.lastError).length;
  $('#feeds-summary').textContent = `${feeds.length} feed${feeds.length === 1 ? '' : 's'} in ${folders.length} folder${folders.length === 1 ? '' : 's'}${errors ? ` · ${errors} with errors` : ''}`;
  $('#bulk-folder').innerHTML = `<option value="">Move selected to…</option><option value="__none">No folder</option>${folders.map((f) => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.name)}</option>`).join('')}`;
  $('#select-all').checked = false;
  renderFolders();
}

function renderFolders() {
  $('#folders-list').innerHTML = folders.length
    ? folders.map((f) => `<div class="folder-row" data-id="${escapeHtml(f.id)}">
        <input type="text" class="fo-name" value="${escapeHtml(f.name)}">
        <span class="small muted">${feeds.filter((x) => x.folderId === f.id).length} feeds</span>
        <button class="fo-delete danger">Delete</button></div>`).join('')
    : '<div class="setting"><span class="muted">No folders yet.</span></div>';
}

const selectedIds = () => $$('#feeds-body tr').filter((tr) => $('.sel', tr).checked).map((tr) => tr.dataset.id);

function bindFeeds() {
  $('#feed-filter').addEventListener('input', renderFeeds);
  $('#select-all').addEventListener('change', (e) => $$('#feeds-body .sel').forEach((c) => { c.checked = e.target.checked; }));

  const body = $('#feeds-body');
  body.addEventListener('change', async (e) => {
    const tr = e.target.closest('tr');
    if (!tr || e.target.classList.contains('sel')) return;
    const id = tr.dataset.id;
    const f = feeds.find((x) => x.id === id);
    let patch = null;
    if (e.target.classList.contains('f-title')) {
      const v = e.target.value.trim();
      patch = { customTitle: v && v !== f.title ? v : '', m: Date.now() };
    } else if (e.target.classList.contains('f-folder')) {
      patch = { folderId: e.target.value || null, m: Date.now() };
    } else if (e.target.classList.contains('f-interval')) {
      patch = { interval: Number(e.target.value) || null };
    } else if (e.target.classList.contains('f-notify')) {
      patch = { notify: e.target.value === 'on' ? true : e.target.value === 'off' ? false : null };
    }
    if (!patch) return;
    Object.assign(f, await db.updateFeed(id, patch));
    if ('m' in patch) changed();
    toast('Saved');
  });
  body.addEventListener('click', async (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const id = tr.dataset.id;
    const f = feeds.find((x) => x.id === id);
    if (e.target.closest('.f-delete')) {
      if (!confirm(`Unsubscribe from “${feedTitle(f)}”?`)) return;
      await db.deleteFeed(id);
      changed();
      await loadData();
      renderFeeds();
    } else if (e.target.closest('.f-refresh')) {
      e.target.disabled = true;
      e.target.textContent = '…';
      try { await send('refresh', { feedIds: [id] }); } catch (err) { toast(err.message); }
      await loadData();
      renderFeeds();
    } else if (e.target.closest('.f-pause')) {
      await db.updateFeed(id, { paused: !f.paused });
      await loadData();
      renderFeeds();
    }
  });

  $('#bulk-folder').addEventListener('change', async (e) => {
    const ids = selectedIds();
    if (!e.target.value || !ids.length) { e.target.value = ''; if (!ids.length) toast('Select feeds first'); return; }
    const folderId = e.target.value === '__none' ? null : e.target.value;
    for (const id of ids) await db.updateFeed(id, { folderId, m: Date.now() });
    changed();
    await loadData();
    renderFeeds();
    toast(`Moved ${ids.length} feed${ids.length === 1 ? '' : 's'}`);
  });
  $('#bulk-delete').addEventListener('click', async () => {
    const ids = selectedIds();
    if (!ids.length) return toast('Select feeds first');
    if (!confirm(`Unsubscribe from ${ids.length} feed${ids.length === 1 ? '' : 's'}? Their posts will be deleted.`)) return undefined;
    for (const id of ids) await db.deleteFeed(id);
    changed();
    await loadData();
    renderFeeds();
    return undefined;
  });
  $('#bulk-refresh').addEventListener('click', async () => {
    const ids = selectedIds();
    if (!ids.length) return toast('Select feeds first');
    toast('Refreshing…');
    try { const { added } = await send('refresh', { feedIds: ids }); toast(`${added} new posts`); } catch (e) { toast(e.message); }
    await loadData();
    renderFeeds();
    return undefined;
  });
  $('#new-folder').addEventListener('click', async () => {
    const name = prompt('Folder name');
    if (!name?.trim()) return;
    await db.putFolder({ id: uid(), name: name.trim(), order: folders.length, collapsed: false });
    await loadData();
    renderFeeds();
  });
  $('#folders-list').addEventListener('change', async (e) => {
    const row = e.target.closest('.folder-row');
    if (!row || !e.target.classList.contains('fo-name')) return;
    const folder = folders.find((f) => f.id === row.dataset.id);
    const name = e.target.value.trim();
    if (!name) { e.target.value = folder.name; return; }
    await db.putFolder({ ...folder, name });
    for (const f of feeds.filter((x) => x.folderId === folder.id)) await db.updateFeed(f.id, { m: Date.now() });
    changed();
    await loadData();
    renderFeeds();
    toast('Folder renamed');
  });
  $('#folders-list').addEventListener('click', async (e) => {
    const row = e.target.closest('.folder-row');
    if (!row || !e.target.closest('.fo-delete')) return;
    const folder = folders.find((f) => f.id === row.dataset.id);
    if (!confirm(`Delete folder “${folder.name}”? Feeds inside it are kept and moved to the top level.`)) return;
    for (const f of feeds.filter((x) => x.folderId === folder.id)) await db.updateFeed(f.id, { m: Date.now() });
    await db.deleteFolder(folder.id);
    changed();
    await loadData();
    renderFeeds();
  });
}

// ---------------------------------------------------------------------------
// Feed health
// ---------------------------------------------------------------------------

let healthRows = [];

async function loadHealth() {
  const stats = await db.getFeedStats(feeds.map((f) => f.id), { windowDays: 30 });
  healthRows = assessFeeds(feeds, stats);
  renderHealth();
}

function renderHealth() {
  const count = (k) => healthRows.filter((r) => r[k]).length;
  const cards = [
    ['failing', 'Failing', 'Errors for 3+ checks or 3+ days'],
    ['inactive', 'Inactive', 'No posts in 90+ days'],
    ['noisy', 'Noisy', '20+ posts/week and 3× the typical feed'],
  ];
  $('#health-summary').innerHTML = `<button class="health-card" data-hfilter="all"><b>${healthRows.length}</b>Feeds</button>${cards.map(([k, label, hint]) =>
    `<button class="health-card${count(k) ? ' warn' : ''}" data-hfilter="${k}" title="${hint}"><b>${count(k)}</b>${label}<div class="small muted">${hint}</div></button>`).join('')}`;

  const filter = $('#health-filter').value;
  const sort = $('#health-sort').value;
  let rows = healthRows.filter((r) => filter === 'all' || (filter === 'issues' ? r.failing || r.inactive || r.noisy : r[filter]));
  const by = {
    perWeek: (a, b) => b.perWeek - a.perWeek,
    latest: (a, b) => (a.latest || 0) - (b.latest || 0),
    unread: (a, b) => b.unread - a.unread,
    name: (a, b) => feedTitle(a.feed).localeCompare(feedTitle(b.feed)),
  }[sort];
  rows = [...rows].sort(by);
  const now = Date.now();
  $('#health-body').innerHTML = rows.map((r) => {
    const f = r.feed;
    const badges = [
      r.failing ? `<span class="badge failing" title="${escapeHtml(f.lastError)}">Failing</span>` : '',
      r.inactive ? '<span class="badge inactive">Inactive</span>' : '',
      r.noisy ? '<span class="badge noisy">Noisy</span>' : '',
      f.snoozedUntil > now ? '<span class="badge snoozed">Snoozed</span>' : '',
    ].join('') || '<span class="badge ok">OK</span>';
    const hint = r.failing ? escapeHtml(f.lastError) : r.noisy ? 'Consider a filter rule or snoozing it' : '';
    return `<tr data-id="${escapeHtml(f.id)}">
      <td><div class="title-cell">${iconImg(f, 'fav')}<b>${escapeHtml(feedTitle(f))}</b></div>${hint ? `<div class="url">${hint}</div>` : ''}</td>
      <td class="num">${r.perWeek >= 10 ? Math.round(r.perWeek) : r.perWeek.toFixed(1)}</td>
      <td>${r.latest ? `<span title="${escapeHtml(formatDate(r.latest))}">${escapeHtml(timeAgo(r.latest))}${/^\d+[mhd]$/.test(timeAgo(r.latest)) ? ' ago' : ''}</span>` : '<span class="muted">never</span>'}</td>
      <td class="num">${r.unread}</td>
      <td>${badges}</td>
      <td class="row-actions">
        ${f.snoozedUntil > now ? '<button class="h-wake">Wake</button>' : '<button class="h-snooze" title="Skip this feed for a week; its posts during that time arrive already read">Snooze 1 week</button>'}
        <button class="h-delete danger">Unsubscribe</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="muted" style="padding:16px">Nothing here.</td></tr>';
  attachIconFallbacks($('#health-body'));
}

function bindHealth() {
  $('#health-filter').addEventListener('change', renderHealth);
  $('#health-sort').addEventListener('change', renderHealth);
  $('#health-summary').addEventListener('click', (e) => {
    const card = e.target.closest('[data-hfilter]');
    if (!card) return;
    $('#health-filter').value = card.dataset.hfilter;
    renderHealth();
  });
  $('#health-body').addEventListener('click', async (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const f = feeds.find((x) => x.id === tr.dataset.id);
    if (e.target.closest('.h-delete')) {
      if (!confirm(`Unsubscribe from “${feedTitle(f)}”?`)) return;
      await db.deleteFeed(f.id);
      changed();
    } else if (e.target.closest('.h-snooze')) {
      await db.updateFeed(f.id, { snoozedUntil: Date.now() + 7 * 86400000 });
      await db.markAllRead([f.id]);
      await send('unreadChanged').catch(() => {});
      toast(`Snoozed ${feedTitle(f)} for a week`);
    } else if (e.target.closest('.h-wake')) {
      await db.updateFeed(f.id, { snoozedUntil: 0 });
      toast('Woken up');
    } else return;
    await loadData();
    renderFeeds();
    await loadHealth();
  });
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

let editingRuleId = null;

function describeRule(r) {
  const scope = r.feedIds?.length
    ? `in ${r.feedIds.map((id) => feeds.find((f) => f.id === id)).filter(Boolean).map(feedTitle).join(', ') || 'removed feeds'}`
    : 'in all feeds';
  return `${RULE_FIELDS[r.field]} ${RULE_OPS[r.op]} “${r.value}” ${scope} → ${r.actions.map((a) => RULE_ACTIONS[a].split(' (')[0].toLowerCase()).join(', ')}`;
}

function renderRules() {
  $('#rules-list').innerHTML = rules.length ? rules.map((r) => `<div class="rule${r.enabled ? '' : ' disabled'}" data-id="${escapeHtml(r.id)}">
      <input type="checkbox" class="r-enabled" title="Enabled"${r.enabled ? ' checked' : ''}>
      <div class="desc"><div class="n">${escapeHtml(r.name || r.value)}</div><div class="d">${escapeHtml(describeRule(r))}</div></div>
      <button class="r-apply" title="Apply this rule's actions to posts you already have">Apply to existing</button>
      <button class="r-edit">Edit</button>
      <button class="r-delete danger">Delete</button>
    </div>`).join('') : '<div class="card"><div class="setting"><span class="muted">No rules yet. Create one to get keyword alerts or filter out noise.</span></div></div>';
}

function openRuleForm(rule = null) {
  editingRuleId = rule?.id || null;
  const r = rule || { name: '', field: 'any', op: 'contains', value: '', caseSensitive: false, feedIds: [], actions: ['notify', 'highlight'], enabled: true };
  $('#rule-form-title').textContent = rule ? 'Edit rule' : 'New rule';
  $('#rule-name').value = r.name;
  $('#rule-field').innerHTML = Object.entries(RULE_FIELDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  $('#rule-field').value = r.field;
  $('#rule-op').innerHTML = Object.entries(RULE_OPS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  $('#rule-op').value = r.op;
  $('#rule-value').value = r.value;
  $('#rule-case').checked = !!r.caseSensitive;
  $('#rule-feeds').innerHTML = feeds.map((f) => `<option value="${escapeHtml(f.id)}"${r.feedIds?.includes(f.id) ? ' selected' : ''}>${escapeHtml(feedTitle(f))}</option>`).join('');
  $('#rule-actions').innerHTML = Object.entries(RULE_ACTIONS).map(([k, v]) => `<label class="check"><input type="checkbox" value="${k}"${r.actions.includes(k) ? ' checked' : ''}> ${v}</label>`).join('');
  $('#rule-error').textContent = '';
  $('#rule-preview').textContent = '';
  $('#rule-form').hidden = false;
  $('#rule-form').scrollIntoView({ behavior: 'smooth' });
  $('#rule-value').focus();
}

function readRuleForm() {
  const existing = rules.find((r) => r.id === editingRuleId);
  return {
    id: editingRuleId || uid(),
    enabled: existing ? existing.enabled : true,
    name: $('#rule-name').value.trim(),
    field: $('#rule-field').value,
    op: $('#rule-op').value,
    value: $('#rule-value').value.trim(),
    caseSensitive: $('#rule-case').checked,
    feedIds: Array.from($('#rule-feeds').selectedOptions).map((o) => o.value),
    actions: $$('#rule-actions input:checked').map((i) => i.value),
  };
}

async function postsForRule(rule) {
  const feedIds = rule.feedIds?.length ? rule.feedIds : feeds.map((f) => f.id);
  const { posts } = await db.queryPosts({ feedIds, filter: 'all', offset: 0, limit: 100000 });
  return posts.filter((p) => ruleMatches({ ...rule, enabled: true }, p));
}

async function applyRuleToExisting(rule) {
  const matches = await postsForRule(rule);
  if (!matches.length) return toast('No existing posts match');
  if (!confirm(`Apply “${rule.name || rule.value}” to ${matches.length} existing post${matches.length === 1 ? '' : 's'}?`)) return undefined;
  const ids = matches.map((p) => p.id);
  if (rule.actions.includes('delete')) await db.deletePosts(ids.filter((id) => !matches.find((p) => p.id === id).starred));
  else {
    if (rule.actions.includes('markRead')) await db.setRead(ids, true);
    for (const id of ids) {
      if (rule.actions.includes('star')) await db.setStarred(id, true);
      if (rule.actions.includes('highlight')) await db.updatePost(id, { highlight: 1 });
    }
  }
  await send('unreadChanged').catch(() => {});
  toast(`Applied to ${matches.length} posts`);
  return undefined;
}

function bindRules() {
  $('#rule-new').addEventListener('click', () => openRuleForm());
  $('#rule-cancel').addEventListener('click', () => { $('#rule-form').hidden = true; });
  $('#rule-test').addEventListener('click', async () => {
    const r = readRuleForm();
    const err = validateRule({ ...r, actions: ['highlight'] });
    if (err) { $('#rule-error').textContent = err; return; }
    const matches = await postsForRule(r);
    $('#rule-preview').innerHTML = `${matches.length} of your stored posts match.${matches.length ? `<br>${matches.slice(0, 5).map((p) => `• ${escapeHtml(p.title)}`).join('<br>')}` : ''}`;
  });
  $('#rule-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = readRuleForm();
    const err = validateRule(r);
    if (err) { $('#rule-error').textContent = err; return; }
    const idx = rules.findIndex((x) => x.id === r.id);
    if (idx >= 0) rules[idx] = r; else rules.push(r);
    await saveRules(rules);
    $('#rule-form').hidden = true;
    renderRules();
    toast('Rule saved — it applies to new posts');
  });
  $('#rules-list').addEventListener('click', async (e) => {
    const row = e.target.closest('.rule');
    if (!row) return;
    const rule = rules.find((r) => r.id === row.dataset.id);
    if (e.target.closest('.r-edit')) openRuleForm(rule);
    else if (e.target.closest('.r-delete')) {
      if (!confirm('Delete this rule?')) return;
      rules = rules.filter((r) => r.id !== rule.id);
      await saveRules(rules);
      renderRules();
    } else if (e.target.closest('.r-apply')) {
      await applyRuleToExisting(rule);
    }
  });
  $('#rules-list').addEventListener('change', async (e) => {
    if (!e.target.classList.contains('r-enabled')) return;
    const rule = rules.find((r) => r.id === e.target.closest('.rule').dataset.id);
    rule.enabled = e.target.checked;
    await saveRules(rules);
    renderRules();
  });
}

// ---------------------------------------------------------------------------
// Import / export
// ---------------------------------------------------------------------------

async function importOpmlText(text) {
  const status = $('#import-status');
  try {
    const list = parseOpml(text);
    if (!list.length) throw new Error('No feeds found in this file');
    status.textContent = `Importing ${list.length} feeds…`;
    const { added, skipped } = await send('importFeeds', { feeds: list });
    status.innerHTML = `<b>Imported ${added} feed${added === 1 ? '' : 's'}</b>${skipped ? `, skipped ${skipped} (already subscribed or invalid)` : ''}. They’re being fetched in the background.`;
    await loadData();
    renderFeeds();
  } catch (e) {
    status.innerHTML = `<span class="error-text">${escapeHtml(e.message)}</span>`;
  }
}

async function exportBackup() {
  await loadData();
  const names = new Map(folders.map((f) => [f.id, f.name]));
  const urls = new Map(feeds.map((f) => [f.id, f.url]));
  const starred = await db.getStarredPosts();
  const backup = {
    app: 'tributary',
    format: 1,
    exportedAt: new Date().toISOString(),
    settings: await getSettings(),
    rules: await getRules(),
    folders: folders.map((f) => ({ name: f.name, order: f.order ?? 0 })),
    feeds: feeds.map((f) => ({
      url: f.url, title: f.title, customTitle: f.customTitle, siteUrl: f.siteUrl, folder: names.get(f.folderId) || null,
      interval: f.interval, notify: f.notify, paused: f.paused, fullArticle: f.fullArticle,
    })),
    starred: starred.map((p) => ({
      feedUrl: urls.get(p.feedId), guid: p.guid, title: p.title, link: p.link, author: p.author, published: p.published,
      image: p.image, enclosures: p.enclosures, snippet: p.snippet, text: p.text, contentHtml: p.contentHtml,
    })),
  };
  downloadText(`tributary-backup-${dateStamp()}.json`, JSON.stringify(backup, null, 2), 'application/json');
}

async function restoreBackup(text) {
  const status = $('#backup-status');
  try {
    const data = JSON.parse(text);
    if (data.app !== 'tributary' || !Array.isArray(data.feeds)) throw new Error('This is not a Tributary backup file');
    if (!confirm(`Restore ${data.feeds.length} feeds, ${data.rules?.length || 0} rules and ${data.starred?.length || 0} starred posts? Existing feeds are kept; settings will be replaced.`)) return;
    status.textContent = 'Restoring…';
    for (const f of data.folders || []) {
      const all = await db.getAllFolders();
      if (!all.some((x) => x.name.toLowerCase() === f.name.toLowerCase())) await db.putFolder({ id: uid(), name: f.name, order: f.order ?? all.length, collapsed: false });
    }
    const { added } = await send('importFeeds', { feeds: data.feeds.map((f) => ({ url: f.url, title: f.title, folder: f.folder, siteUrl: f.siteUrl })) });
    const current = await db.getAllFeeds();
    for (const f of data.feeds) {
      const local = current.find((x) => x.url === f.url);
      if (local) await db.updateFeed(local.id, { customTitle: f.customTitle || '', interval: f.interval ?? null, notify: f.notify ?? null, paused: !!f.paused, fullArticle: !!f.fullArticle });
    }
    if (data.settings) settings = await saveSettings(data.settings);
    if (Array.isArray(data.rules)) {
      const existing = await getRules();
      const ids = new Set(existing.map((r) => r.id));
      await saveRules([...existing, ...data.rules.filter((r) => !ids.has(r.id))]);
    }
    let starredCount = 0;
    for (const s of data.starred || []) {
      const feed = current.find((x) => x.url === s.feedUrl);
      if (!feed || !s.guid) continue;
      const id = postId(feed.id, s.guid);
      await db.addPosts([{
        id, feedId: feed.id, guid: s.guid, title: s.title, link: s.link, author: s.author, published: s.published || Date.now(),
        fetchedAt: Date.now(), snippet: s.snippet || '', text: s.text || '', image: s.image || '', enclosures: s.enclosures || [],
        contentHtml: s.contentHtml || '', chash: hash(`${s.title}\u0000${s.contentHtml || ''}`), read: 1, starred: 1, highlight: 0,
      }]);
      await db.setStarred(id, true);
      starredCount++;
    }
    status.innerHTML = `<b>Restored.</b> ${added} new feeds, ${starredCount} starred posts.`;
    await send('unreadChanged').catch(() => {});
    location.reload();
  } catch (e) {
    status.innerHTML = `<span class="error-text">${escapeHtml(e.message)}</span>`;
  }
}

function bindImport() {
  const readFile = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
  $('#opml-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) await importOpmlText(await readFile(file));
    e.target.value = '';
  });
  const zone = $('#drop-zone');
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    const file = e.dataTransfer.files[0];
    if (file) await importOpmlText(await readFile(file));
  });
  $('#export-opml').addEventListener('click', async () => {
    await loadData();
    if (!feeds.length) return toast('No feeds to export');
    downloadText(`tributary-subscriptions-${dateStamp()}.opml`, buildOpml(feeds, folders), 'text/x-opml');
    return undefined;
  });
  $('#export-json').addEventListener('click', exportBackup);
  $('#json-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) await restoreBackup(await readFile(file));
    e.target.value = '';
  });
}

// ---------------------------------------------------------------------------
// Sync & misc
// ---------------------------------------------------------------------------

async function renderSyncStatus() {
  const { syncState } = await chrome.storage.local.get('syncState');
  const el = $('#sync-status');
  if (!settings.syncSubscriptions) el.textContent = 'Sync is off.';
  else if (!syncState?.lastSyncAt) el.textContent = 'Not synced yet.';
  else if (syncState.lastError) el.innerHTML = `<span class="error-text">Last attempt ${escapeHtml(timeAgo(syncState.lastSyncAt))} ago failed: ${escapeHtml(syncState.lastError)}</span>`;
  else el.textContent = `Last synced ${timeAgo(syncState.lastSyncAt)}${syncState.lastSyncAt ? ' ago' : ''}${syncState.bytes ? ` · ${(syncState.bytes / 1024).toFixed(1)} KB used of ~100 KB` : ''}.`;
}

function bindMisc() {
  $('#open-reader').addEventListener('click', () => send('openReader', {}));
  $('#sync-now').addEventListener('click', async () => {
    try { await send('syncNow'); toast('Synced'); } catch (e) { toast(`Sync failed: ${e.message}`); }
    renderSyncStatus();
  });
  $('#shortcuts-link').addEventListener('click', (e) => { e.preventDefault(); chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }); });
  $('#wipe').addEventListener('click', async () => {
    if (!confirm('Delete ALL feeds, posts, folders, rules and settings on this device? Consider exporting a backup first.')) return;
    if (!confirm('Really delete everything? This cannot be undone.')) return;
    await chrome.storage.local.set({ syncState: {} });
    await db.clearAll();
    await chrome.storage.local.remove(['settings', 'rules', 'rulesUpdatedAt']);
    await send('unreadChanged').catch(() => {});
    toast('All data deleted');
    setTimeout(() => location.reload(), 800);
  });
  $('#tabs').addEventListener('click', (e) => {
    const a = e.target.closest('a[data-tab]');
    if (!a) return;
    e.preventDefault();
    history.replaceState(null, '', `#${a.dataset.tab}`);
    showTab(a.dataset.tab);
  });
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.syncState) renderSyncStatus();
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'subscriptionsUpdated' || (msg?.type === 'refreshState' && !msg.running)) loadData().then(renderFeeds);
    return false;
  });
}

async function init() {
  isBackgroundStale().then((stale) => { if (stale) showUpdateBanner($('main')); });
  settings = await getSettings();
  applyTheme(settings);
  $('#version').textContent = `Version ${chrome.runtime.getManifest().version}`;
  rules = await getRules();
  await loadData();
  bindSettings();
  bindFeeds();
  bindRules();
  bindHealth();
  bindImport();
  bindMisc();
  renderFeeds();
  renderRules();
  renderSyncStatus();
  showTab(location.hash.slice(1) || 'general');
}

init();
