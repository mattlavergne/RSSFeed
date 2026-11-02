// Subscription sync through chrome.storage.sync (follows the user's Chrome profile sign-in, no server needed).
// The payload is gzip-compressed, base64-encoded and split into chunks to fit storage.sync's per-item quota.

const CHUNK = 7500;          // characters per item (QUOTA_BYTES_PER_ITEM is 8192 incl. key)
const PREFIX = 'sub_';
const META = 'sub_meta';

/**
 * Three-way merge of subscription lists.
 * @param {{url:string,title:string,folder:string,m:number}[]} local
 * @param {{url:string,title:string,folder:string,m:number}[]} remote
 * @param {string[]} base urls present at the last successful sync
 */
export function mergeSubscriptions(local, remote, base) {
  const L = new Map(local.map((f) => [f.url, f]));
  const R = new Map(remote.map((f) => [f.url, f]));
  const B = new Set(base);
  const toAdd = [], toRemove = [], toUpdate = [], result = [];

  for (const [url, l] of L) {
    const r = R.get(url);
    if (r) {
      if ((r.m || 0) > (l.m || 0) && (r.title !== l.title || r.folder !== l.folder)) {
        toUpdate.push(r);
        result.push(r);
      } else {
        result.push(l);
      }
    } else if (B.has(url)) {
      toRemove.push(url); // deleted on another device
    } else {
      result.push(l); // added locally since last sync
    }
  }
  for (const [url, r] of R) {
    if (L.has(url)) continue;
    if (B.has(url)) continue; // deleted locally since last sync
    toAdd.push(r);
    result.push(r);
  }
  return { toAdd, toRemove, toUpdate, result };
}

async function gzipBase64(str) {
  const stream = new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function gunzipBase64(b64) {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

export async function writeSyncPayload(payload) {
  const data = await gzipBase64(JSON.stringify(payload));
  const chunks = [];
  for (let i = 0; i < data.length; i += CHUNK) chunks.push(data.slice(i, i + CHUNK));
  const prev = (await chrome.storage.sync.get(META))[META];
  const items = {};
  chunks.forEach((c, i) => { items[PREFIX + i] = c; });
  // Write chunks first, meta last, so readers never see a meta pointing at missing chunks.
  await chrome.storage.sync.set(items);
  await chrome.storage.sync.set({ [META]: { chunks: chunks.length, updatedAt: payload.updatedAt, device: payload.device } });
  if (prev?.chunks > chunks.length) {
    const stale = [];
    for (let i = chunks.length; i < prev.chunks; i++) stale.push(PREFIX + i);
    await chrome.storage.sync.remove(stale);
  }
  return { bytes: data.length, chunks: chunks.length };
}

export async function readSyncPayload() {
  const meta = (await chrome.storage.sync.get(META))[META];
  if (!meta?.chunks) return null;
  const keys = Array.from({ length: meta.chunks }, (_, i) => PREFIX + i);
  const got = await chrome.storage.sync.get(keys);
  if (keys.some((k) => typeof got[k] !== 'string')) return null; // partially synced; try again later
  try {
    return { meta, payload: JSON.parse(await gunzipBase64(keys.map((k) => got[k]).join(''))) };
  } catch {
    return null;
  }
}

export const SYNC_META_KEY = META;
