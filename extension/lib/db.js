// IndexedDB storage. Extension pages and the service worker share one origin, so both use this module.
//
// Stores:
//   feeds   {id, url, title, customTitle, siteUrl, folderId, ...}
//   folders {id, name, order, collapsed}
//   posts   lightweight post metadata (list rendering, counts, search)
//   content heavy HTML bodies, keyed by post id
//
// v2: posts get lkey/tkey (normalised link/title) indexes for duplicate detection.

import { linkKey, titleKey } from './util.js';

const DB_NAME = 'tributary';
const DB_VERSION = 2;
const DAY = 86400000;

/** Add the duplicate-detection keys to a post record (in place). Missing keys stay out of the index. */
export function withDedupeKeys(p) {
  const lk = linkKey(p.link);
  const tk = titleKey(p.title);
  if (lk) p.lkey = lk; else delete p.lkey;
  if (tk) p.tkey = tk; else delete p.tkey;
  return p;
}
let dbPromise = null;

export function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        if (e.oldVersion < 1) {
          db.createObjectStore('feeds', { keyPath: 'id' });
          db.createObjectStore('folders', { keyPath: 'id' });
          const posts = db.createObjectStore('posts', { keyPath: 'id' });
          posts.createIndex('feedId', 'feedId');
          posts.createIndex('feedPublished', ['feedId', 'published']);
          posts.createIndex('feedRead', ['feedId', 'read']);
          posts.createIndex('read', 'read');
          posts.createIndex('starred', 'starred');
          db.createObjectStore('content', { keyPath: 'id' });
        }
        if (e.oldVersion < 2) {
          const posts = req.transaction.objectStore('posts');
          posts.createIndex('lkey', 'lkey');
          posts.createIndex('tkey', 'tkey');
          // Back-fill keys for posts stored before this version.
          posts.openCursor().onsuccess = (ev) => {
            const cursor = ev.target.result;
            if (!cursor) return;
            cursor.update(withDedupeKeys({ ...cursor.value }));
            cursor.continue();
          };
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => { dbPromise = null; reject(req.error); };
    });
  }
  return dbPromise;
}

const reqP = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

// Only IDB requests may be awaited inside fn, otherwise the transaction auto-commits.
async function tx(stores, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
    Promise.resolve(fn(t)).then((r) => { result = r; }, (err) => {
      try { t.abort(); } catch { /* already finished */ }
      reject(err);
    });
  });
}

function eachCursor(source, range, direction, onItem) {
  return new Promise((resolve, reject) => {
    const req = source.openCursor(range, direction);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve();
      if (onItem(cursor) === false) return resolve();
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

const feedRange = (feedId) => IDBKeyRange.bound([feedId, -Infinity], [feedId, Infinity]);

// ---------- feeds ----------

export const getAllFeeds = () => tx('feeds', 'readonly', (t) => reqP(t.objectStore('feeds').getAll()));
export const getFeed = (id) => tx('feeds', 'readonly', (t) => reqP(t.objectStore('feeds').get(id)));
export const putFeed = (feed) => tx('feeds', 'readwrite', (t) => { t.objectStore('feeds').put(feed); return feed; });

export function putFeeds(feeds) {
  return tx('feeds', 'readwrite', (t) => { const s = t.objectStore('feeds'); feeds.forEach((f) => s.put(f)); return feeds; });
}

export function updateFeed(id, patch) {
  return tx('feeds', 'readwrite', async (t) => {
    const s = t.objectStore('feeds');
    const feed = await reqP(s.get(id));
    if (!feed) return null;
    const next = { ...feed, ...patch };
    s.put(next);
    return next;
  });
}

export function deleteFeed(id) {
  return tx(['feeds', 'posts', 'content'], 'readwrite', async (t) => {
    t.objectStore('feeds').delete(id);
    const posts = t.objectStore('posts');
    const content = t.objectStore('content');
    const keys = await reqP(posts.index('feedId').getAllKeys(IDBKeyRange.only(id)));
    for (const k of keys) { posts.delete(k); content.delete(k); }
    return keys.length;
  });
}

// ---------- folders ----------

export const getAllFolders = () => tx('folders', 'readonly', (t) => reqP(t.objectStore('folders').getAll()));
export const putFolder = (folder) => tx('folders', 'readwrite', (t) => { t.objectStore('folders').put(folder); return folder; });

export function deleteFolder(id, { deleteFeeds = false } = {}) {
  return tx(['folders', 'feeds', 'posts', 'content'], 'readwrite', async (t) => {
    t.objectStore('folders').delete(id);
    const feeds = t.objectStore('feeds');
    const all = await reqP(feeds.getAll());
    for (const f of all.filter((f) => f.folderId === id)) {
      if (deleteFeeds) {
        feeds.delete(f.id);
        const posts = t.objectStore('posts');
        const keys = await reqP(posts.index('feedId').getAllKeys(IDBKeyRange.only(f.id)));
        for (const k of keys) { posts.delete(k); t.objectStore('content').delete(k); }
      } else {
        feeds.put({ ...f, folderId: null });
      }
    }
  });
}

// ---------- posts ----------

/**
 * Find an earlier post that is the same story: same canonical link (any feed, within 30 days)
 * or the same headline from a different feed (within 3 days).
 */
async function findDuplicate(store, meta) {
  const near = (other, days) => other.id !== meta.id && Math.abs((other.published || 0) - (meta.published || 0)) <= days * DAY;
  if (meta.lkey) {
    const same = await reqP(store.index('lkey').getAll(IDBKeyRange.only(meta.lkey), 20));
    const hit = same.find((o) => near(o, 30));
    if (hit) return hit;
  }
  if (meta.tkey) {
    const same = await reqP(store.index('tkey').getAll(IDBKeyRange.only(meta.tkey), 20));
    const hit = same.find((o) => o.feedId !== meta.feedId && near(o, 3));
    if (hit) return hit;
  }
  return null;
}

/**
 * Insert new posts, update changed ones (keeping read/starred state).
 * With dedupe, a new post that duplicates an existing story is stored as read with dupOf/dupFeedId set.
 * Checking inside the write transaction keeps concurrent feed refreshes from both treating a story as new.
 * @returns {Promise<object[]>} the newly added post metadata records
 */
export function addPosts(posts, { dedupe = false } = {}) {
  return tx(['posts', 'content'], 'readwrite', async (t) => {
    const store = t.objectStore('posts');
    const content = t.objectStore('content');
    const added = [];
    for (const p of posts) {
      const { contentHtml = '', ...meta } = p;
      withDedupeKeys(meta);
      const existing = await reqP(store.get(p.id));
      if (!existing) {
        if (dedupe) {
          const dup = await findDuplicate(store, meta);
          if (dup) Object.assign(meta, { read: 1, dupOf: dup.id, dupFeedId: dup.feedId });
        }
        store.put(meta);
        content.put({ id: p.id, html: contentHtml });
        added.push(meta);
      } else if (existing.chash !== meta.chash || existing.title !== meta.title) {
        store.put({
          ...existing,
          title: meta.title, link: meta.link || existing.link, author: meta.author,
          snippet: meta.snippet, text: meta.text, image: meta.image, enclosures: meta.enclosures,
          chash: meta.chash, updatedAt: Date.now(),
          ...(meta.lkey ? { lkey: meta.lkey } : {}), ...(meta.tkey ? { tkey: meta.tkey } : {}),
        });
        content.put({ id: p.id, html: contentHtml });
      }
    }
    return added;
  });
}

export function getExistingIds(ids) {
  return tx('posts', 'readonly', async (t) => {
    const s = t.objectStore('posts');
    const out = new Set();
    for (const id of ids) if (await reqP(s.getKey(id))) out.add(id);
    return out;
  });
}

export const getPost = (id) => tx('posts', 'readonly', (t) => reqP(t.objectStore('posts').get(id)));
export const getContent = (id) => tx('content', 'readonly', (t) => reqP(t.objectStore('content').get(id)));

export function updateContent(id, patch) {
  return tx('content', 'readwrite', async (t) => {
    const s = t.objectStore('content');
    const cur = (await reqP(s.get(id))) || { id };
    s.put({ ...cur, ...patch });
  });
}

export function updatePost(id, patch) {
  return tx('posts', 'readwrite', async (t) => {
    const s = t.objectStore('posts');
    const p = await reqP(s.get(id));
    if (!p) return null;
    const next = { ...p, ...patch };
    s.put(next);
    return next;
  });
}

export function setRead(ids, read = true) {
  return tx('posts', 'readwrite', async (t) => {
    const s = t.objectStore('posts');
    let changed = 0;
    for (const id of ids) {
      const p = await reqP(s.get(id));
      if (p && p.read !== (read ? 1 : 0)) {
        s.put({ ...p, read: read ? 1 : 0, readAt: read ? Date.now() : 0 });
        changed++;
      }
    }
    return changed;
  });
}

export const setStarred = (id, starred) => updatePost(id, { starred: starred ? 1 : 0, starredAt: starred ? Date.now() : 0 });

/** Mark everything unread in the given feeds as read. olderThan (ms timestamp) is optional. */
export function markAllRead(feedIds, { olderThan = Infinity } = {}) {
  return tx('posts', 'readwrite', async (t) => {
    const s = t.objectStore('posts');
    const idx = s.index('feedRead');
    let changed = 0;
    const now = Date.now();
    for (const fid of feedIds) {
      const unread = await reqP(idx.getAll(IDBKeyRange.only([fid, 0])));
      for (const p of unread) {
        if (p.published > olderThan) continue;
        s.put({ ...p, read: 1, readAt: now });
        changed++;
      }
    }
    return changed;
  });
}

function matchesSearch(p, terms) {
  if (!terms.length) return true;
  const hay = `${p.title || ''} ${p.author || ''} ${p.text || p.snippet || ''}`.toLowerCase();
  return terms.every((term) => hay.includes(term));
}

/**
 * Query posts for the list view.
 * @param {object} q
 * @param {string[]} q.feedIds   feeds in scope
 * @param {'all'|'unread'|'starred'} q.filter
 * @param {string} [q.search]
 * @param {'newest'|'oldest'} [q.sort]
 */
export function queryPosts({ feedIds, filter = 'all', search = '', sort = 'newest', offset = 0, limit = 50 }) {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  const need = offset + limit + 1;
  const cmp = sort === 'oldest'
    ? (a, b) => a.published - b.published || (a.id < b.id ? -1 : 1)
    : (a, b) => b.published - a.published || (a.id < b.id ? 1 : -1);
  const scope = new Set(feedIds);

  return tx('posts', 'readonly', async (t) => {
    const s = t.objectStore('posts');
    let found = [];
    if (filter === 'starred') {
      const all = await reqP(s.index('starred').getAll(IDBKeyRange.only(1)));
      found = all.filter((p) => scope.has(p.feedId) && matchesSearch(p, terms));
    } else {
      const idx = s.index('feedPublished');
      const direction = sort === 'oldest' ? 'next' : 'prev';
      for (const fid of feedIds) {
        let n = 0;
        await eachCursor(idx, feedRange(fid), direction, (cursor) => {
          const p = cursor.value;
          if (filter === 'unread' && p.read) return true;
          if (!matchesSearch(p, terms)) return true;
          found.push(p);
          return ++n < need;
        });
      }
    }
    found.sort(cmp);
    return { posts: found.slice(offset, offset + limit), hasMore: found.length > offset + limit };
  });
}

/** Ids of all posts matching a view, used for "mark all as read" on filtered/search views. */
export async function queryAllIds(q) {
  const { posts } = await queryPosts({ ...q, offset: 0, limit: 100000 });
  return posts.map((p) => p.id);
}

export function getUnreadCounts(feedIds) {
  return tx('posts', 'readonly', async (t) => {
    const idx = t.objectStore('posts').index('feedRead');
    const counts = {};
    for (const fid of feedIds) counts[fid] = await reqP(idx.count(IDBKeyRange.only([fid, 0])));
    return counts;
  });
}

export const getTotalUnread = () => tx('posts', 'readonly', (t) => reqP(t.objectStore('posts').index('read').count(IDBKeyRange.only(0))));
export const getStarredCount = () => tx('posts', 'readonly', (t) => reqP(t.objectStore('posts').index('starred').count(IDBKeyRange.only(1))));

/**
 * Per-feed statistics for the health report.
 * @returns {Promise<Record<string,{recent:number,latest:number,total:number,unread:number}>>}
 */
export function getFeedStats(feedIds, { windowDays = 30 } = {}) {
  const cutoff = Date.now() - windowDays * DAY;
  return tx('posts', 'readonly', async (t) => {
    const s = t.objectStore('posts');
    const out = {};
    for (const fid of feedIds) {
      // oldest = oldest post inside the window; complete = stored history reaches back past the window.
      const st = { recent: 0, latest: 0, total: 0, unread: 0, oldest: 0, complete: false };
      st.total = await reqP(s.index('feedId').count(IDBKeyRange.only(fid)));
      st.unread = await reqP(s.index('feedRead').count(IDBKeyRange.only([fid, 0])));
      await eachCursor(s.index('feedPublished'), feedRange(fid), 'prev', (cursor) => {
        const p = cursor.value;
        if (!st.latest) st.latest = p.published;
        if (p.published < cutoff) { st.complete = true; return false; }
        st.recent++;
        st.oldest = p.published;
        return true;
      });
      out[fid] = st;
    }
    return out;
  });
}

export function getStarredPosts() {
  return tx(['posts', 'content'], 'readonly', async (t) => {
    const posts = await reqP(t.objectStore('posts').index('starred').getAll(IDBKeyRange.only(1)));
    const content = t.objectStore('content');
    for (const p of posts) p.contentHtml = (await reqP(content.get(p.id)))?.html || '';
    return posts;
  });
}

/**
 * Delete old posts for one feed. Starred posts and posts still present in the
 * feed document (protectIds) are never deleted, so they cannot re-appear as unread.
 */
export function prunePosts(feedId, { maxPosts = 300, keepReadDays = 60, protectIds = new Set() } = {}) {
  const cutoff = keepReadDays > 0 ? Date.now() - keepReadDays * 86400000 : -Infinity;
  return tx(['posts', 'content'], 'readwrite', async (t) => {
    const s = t.objectStore('posts');
    const content = t.objectStore('content');
    let i = 0, removed = 0;
    await eachCursor(s.index('feedPublished'), feedRange(feedId), 'prev', (cursor) => {
      const p = cursor.value;
      i++;
      if (p.starred || protectIds.has(p.id)) return true;
      if (i > maxPosts || (p.read && p.published < cutoff)) {
        s.delete(p.id);
        content.delete(p.id);
        removed++;
      }
      return true;
    });
    return removed;
  });
}

export function deletePosts(ids) {
  return tx(['posts', 'content'], 'readwrite', (t) => {
    for (const id of ids) { t.objectStore('posts').delete(id); t.objectStore('content').delete(id); }
    return ids.length;
  });
}

export function clearAll() {
  return tx(['feeds', 'folders', 'posts', 'content'], 'readwrite', (t) => {
    for (const name of ['feeds', 'folders', 'posts', 'content']) t.objectStore(name).clear();
  });
}
