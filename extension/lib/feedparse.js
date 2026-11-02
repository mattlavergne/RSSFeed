// Feed parsing. Requires DOMParser, so it runs in the offscreen document or a UI page.
// Supports RSS 2.0/0.9x, RSS 1.0 (RDF), Atom 1.0/0.3 and JSON Feed 1.x.

import { escapeHtml, resolveUrl } from './util.js';

const NS = {
  atom: 'http://www.w3.org/2005/Atom',
  atom03: 'http://purl.org/atom/ns#',
  rss1: 'http://purl.org/rss/1.0/',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  content: 'http://purl.org/rss/1.0/modules/content/',
  dc: 'http://purl.org/dc/elements/1.1/',
  media: 'http://search.yahoo.com/mrss/',
  itunes: 'http://www.itunes.com/dtds/podcast-1.0.dtd',
};

const MAX_CONTENT = 400_000;
const MAX_TEXT = 3000;

export class FeedParseError extends Error {}

// ---------- helpers ----------

function kids(el, name, nsList) {
  const out = [];
  if (!el) return out;
  for (const c of el.children) {
    if (nsList ? (c.localName === name && nsList.includes(c.namespaceURI)) : c.localName.toLowerCase() === name.toLowerCase()) out.push(c);
  }
  return out;
}
const kid = (el, name, nsList) => kids(el, name, nsList)[0] || null;
const txt = (el) => (el ? el.textContent.trim() : '');

function parseDate(s) {
  if (!s) return 0;
  s = s.trim();
  let t = Date.parse(s);
  if (!Number.isNaN(t)) return t;
  // Common broken formats: "Mon, 2 Jan 2023 10:00:00 +0000 (UTC)", "2023-01-02 10:00:00"
  t = Date.parse(s.replace(/\s*\(.*\)$/, '').replace(/^(\d{4}-\d\d-\d\d) /, '$1T'));
  if (!Number.isNaN(t)) return t;
  // Drop leading weekday name in other languages.
  t = Date.parse(s.replace(/^[^,\d]+,\s*/, ''));
  return Number.isNaN(t) ? 0 : t;
}

// Titles may contain escaped entities and occasionally inline markup; never treat them as full HTML.
const INLINE_TAGS = /<\/?(b|i|em|strong|span|a|code|sup|sub|u|small|br|p|mark|s|del|ins|abbr|q|font|cite|div)\b[^>]*>/gi;
function cleanTitle(s) {
  if (!s) return '';
  s = String(s).replace(INLINE_TAGS, '');
  if (s.includes('&')) s = new DOMParser().parseFromString(`<body>${s.replace(/</g, '&lt;')}`, 'text/html').body.textContent;
  return s.replace(/\s+/g, ' ').trim();
}

const BLOCKS = 'p,div,br,li,ul,ol,h1,h2,h3,h4,h5,h6,tr,td,th,blockquote,pre,figure,figcaption,section,article,header,footer,hr,dt,dd,table,img,a';
function htmlToText(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,noscript,template').forEach((n) => n.remove());
  doc.querySelectorAll(BLOCKS).forEach((el) => el.after(' '));
  return (doc.body?.textContent || '').replace(/\s+/g, ' ').replace(/ ([.,;:!?)])/g, '$1').trim();
}

function firstImage(html, base) {
  if (!html || !/<img/i.test(html)) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const img of doc.querySelectorAll('img[src]')) {
    const w = Number(img.getAttribute('width')), h = Number(img.getAttribute('height'));
    if ((w && w <= 2) || (h && h <= 2)) continue; // tracking pixels
    const src = resolveUrl(img.getAttribute('src'), base);
    if (/^https?:/.test(src)) return src;
  }
  return '';
}

function parseXml(text) {
  const parser = new DOMParser();
  let doc = parser.parseFromString(text, 'application/xml');
  if (!doc.querySelector('parsererror')) return doc;
  // Retry with common breakages repaired: stray ampersands, control characters, leading garbage.
  const fixed = text
    .replace(/^[\s\S]*?(<\?xml|<rss|<feed|<rdf:RDF)/i, '$1')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&(?!(?:#\d+|#x[\da-f]+|[a-z][\w.-]*);)/gi, '&amp;');
  doc = parser.parseFromString(fixed, 'application/xml');
  if (!doc.querySelector('parsererror')) return doc;
  // Last resort: the HTML parser is very lenient and keeps element structure for RSS.
  const html = parser.parseFromString(fixed, 'text/html');
  const root = html.querySelector('rss, feed, rdf\\:rdf');
  if (root) return { documentElement: root, lenient: true };
  return null;
}

// ---------- entry points ----------

/**
 * @param {string} text raw response body
 * @param {string} url  final URL of the feed (used to resolve relative links)
 */
export function parseFeed(text, url) {
  const trimmed = String(text || '').replace(/^﻿/, '').trim();
  if (!trimmed) throw new FeedParseError('Empty response');
  if (trimmed.startsWith('{')) return parseJsonFeed(trimmed, url);
  if (/^<!doctype html|^<html/i.test(trimmed)) throw new FeedParseError('This is a web page, not a feed');

  const doc = parseXml(trimmed);
  if (!doc) throw new FeedParseError('Not valid XML');
  const root = doc.documentElement;
  const name = root.localName.toLowerCase();
  if (name === 'rss') return parseRss(root, url, doc.lenient);
  if (name === 'rdf') return parseRdf(root, url);
  if (name === 'feed') return parseAtom(root, url);
  throw new FeedParseError(`Unknown feed format <${root.localName}>`);
}

function finishItem(raw, base) {
  let contentHtml = raw.contentHtml || '';
  if (contentHtml.length > MAX_CONTENT) contentHtml = contentHtml.slice(0, MAX_CONTENT);
  const text = htmlToText(contentHtml).slice(0, MAX_TEXT);
  const title = cleanTitle(raw.title) || text.slice(0, 90) || '(untitled)';
  const link = resolveUrl(raw.link, base);
  return {
    guid: raw.guid || link || `${title}|${raw.published || ''}`,
    title,
    link,
    author: raw.author || '',
    published: raw.published || 0,
    contentHtml,
    text,
    snippet: text.slice(0, 280),
    image: raw.image || firstImage(contentHtml, link || base),
    enclosures: raw.enclosures || [],
  };
}

function mediaImage(item, base) {
  const thumb = kid(item, 'thumbnail', [NS.media]);
  if (thumb?.getAttribute('url')) return resolveUrl(thumb.getAttribute('url'), base);
  for (const group of [item, kid(item, 'group', [NS.media])]) {
    for (const mc of kids(group, 'content', [NS.media])) {
      const t = mc.getAttribute('type') || '';
      if (mc.getAttribute('medium') === 'image' || t.startsWith('image/')) return resolveUrl(mc.getAttribute('url'), base);
      const inner = kid(mc, 'thumbnail', [NS.media]);
      if (inner?.getAttribute('url')) return resolveUrl(inner.getAttribute('url'), base);
    }
  }
  const it = kid(item, 'image', [NS.itunes]);
  if (it?.getAttribute('href')) return resolveUrl(it.getAttribute('href'), base);
  return '';
}

function rssLikeItem(item, base, native) {
  const contentEncoded = txt(kid(item, 'encoded', [NS.content]));
  const description = txt(kid(item, 'description', native));
  const mediaDesc = txt(kid(item, 'description', [NS.media])) || txt(kid(kid(item, 'group', [NS.media]), 'description', [NS.media]));
  let contentHtml = contentEncoded.length >= description.length ? contentEncoded : description;
  if (!contentHtml && mediaDesc) contentHtml = `<p>${escapeHtml(mediaDesc).replace(/\n/g, '<br>')}</p>`;

  const guidEl = kid(item, 'guid', native);
  const guid = txt(guidEl);
  let link = txt(kid(item, 'link', native));
  if (!link) {
    const atomLink = kids(item, 'link', [NS.atom]).find((l) => (l.getAttribute('rel') || 'alternate') === 'alternate');
    link = atomLink?.getAttribute('href') || '';
  }
  if (!link && guid && /^https?:\/\//.test(guid) && guidEl.getAttribute('isPermaLink') !== 'false') link = guid;

  const enclosures = kids(item, 'enclosure', native).map((e) => ({
    url: resolveUrl(e.getAttribute('url'), base),
    type: e.getAttribute('type') || '',
    length: Number(e.getAttribute('length')) || 0,
  })).filter((e) => e.url);
  for (const mc of kids(item, 'content', [NS.media])) {
    const type = mc.getAttribute('type') || '';
    const medium = mc.getAttribute('medium') || '';
    if (/^(audio|video)/.test(type) || medium === 'audio' || medium === 'video') {
      const url = resolveUrl(mc.getAttribute('url'), base);
      if (url && !enclosures.some((e) => e.url === url)) enclosures.push({ url, type: type || `${medium}/*`, length: Number(mc.getAttribute('fileSize')) || 0 });
    }
  }

  let image = mediaImage(item, base);
  if (!image) {
    const imgEnc = enclosures.find((e) => e.type.startsWith('image/'));
    if (imgEnc) image = imgEnc.url;
  }

  return finishItem({
    guid, link, image,
    title: txt(kid(item, 'title', native)) || txt(kid(item, 'title', [NS.media])),
    author: txt(kid(item, 'creator', [NS.dc])) || txt(kid(item, 'author', native)) || txt(kid(item, 'author', [NS.itunes])),
    published: parseDate(txt(kid(item, 'pubDate', native)) || txt(kid(item, 'date', [NS.dc])) || txt(kid(item, 'published', [NS.atom])) || txt(kid(item, 'updated', [NS.atom]))),
    contentHtml,
    enclosures: enclosures.filter((e) => !e.type.startsWith('image/')),
  }, base);
}

function parseRss(root, url, lenient) {
  const native = lenient ? null : [null, ''];
  const channel = kid(root, 'channel', native) || root;
  const base = url;
  const siteUrl = resolveUrl(txt(kid(channel, 'link', native)), base);
  const imageEl = kid(channel, 'image', native);
  const itemsParent = kids(channel, 'item', native).length ? channel : root; // RSS 0.9x sometimes puts items at root
  return {
    title: cleanTitle(txt(kid(channel, 'title', native))) || siteUrl || url,
    siteUrl,
    description: htmlToText(txt(kid(channel, 'description', native))),
    iconUrl: resolveUrl(txt(kid(imageEl, 'url', native)), base) || resolveUrl(kid(channel, 'image', [NS.itunes])?.getAttribute('href'), base),
    items: kids(itemsParent, 'item', native).map((item) => rssLikeItem(item, siteUrl || base, native)),
  };
}

function parseRdf(root, url) {
  const native = [NS.rss1, null, ''];
  const channel = kid(root, 'channel', native);
  const siteUrl = resolveUrl(txt(kid(channel, 'link', native)), url);
  return {
    title: cleanTitle(txt(kid(channel, 'title', native))) || url,
    siteUrl,
    description: htmlToText(txt(kid(channel, 'description', native))),
    iconUrl: resolveUrl(txt(kid(kid(root, 'image', native), 'url', native)), url),
    items: kids(root, 'item', native).map((item) => rssLikeItem(item, siteUrl || url, native)),
  };
}

function atomText(el) {
  if (!el) return '';
  const type = (el.getAttribute('type') || 'text').toLowerCase();
  if (type === 'xhtml') {
    const div = el.firstElementChild;
    const s = new XMLSerializer();
    return div ? Array.from(div.childNodes).map((n) => s.serializeToString(n)).join('').replace(/ xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"/g, '') : '';
  }
  if (type === 'html' || type === 'text/html') return el.textContent.trim();
  return `<p>${escapeHtml(el.textContent.trim()).replace(/\n\s*\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>`;
}

function xmlBase(el, fallback) {
  const chain = [];
  for (let n = el; n && n.nodeType === 1; n = n.parentNode) {
    const b = n.getAttribute('xml:base');
    if (b) chain.unshift(b);
  }
  return chain.reduce((acc, b) => resolveUrl(b, acc) || acc, fallback);
}

function atomLink(el, rel, base) {
  const links = kids(el, 'link', [NS.atom, NS.atom03]);
  const l = links.find((x) => (x.getAttribute('rel') || 'alternate') === rel && (rel !== 'alternate' || !/xml|json/.test(x.getAttribute('type') || '')))
    || (rel === 'alternate' ? links.find((x) => (x.getAttribute('rel') || 'alternate') === 'alternate') : null);
  return l ? resolveUrl(l.getAttribute('href'), base) : '';
}

function parseAtom(root, url) {
  const ns = [NS.atom, NS.atom03];
  const feedBase = xmlBase(root, url);
  const siteUrl = atomLink(root, 'alternate', feedBase);
  const feedAuthor = txt(kid(kid(root, 'author', ns), 'name', ns));
  const items = kids(root, 'entry', ns).map((entry) => {
    const base = xmlBase(entry, feedBase);
    const content = kid(entry, 'content', ns);
    const summary = kid(entry, 'summary', ns);
    const contentHtml = (content && !content.getAttribute('src') ? atomText(content) : '') || atomText(summary)
      || (() => { const d = txt(kid(kid(entry, 'group', [NS.media]), 'description', [NS.media])); return d ? `<p>${escapeHtml(d).replace(/\n/g, '<br>')}</p>` : ''; })();
    const enclosures = kids(entry, 'link', ns).filter((l) => l.getAttribute('rel') === 'enclosure').map((l) => ({
      url: resolveUrl(l.getAttribute('href'), base), type: l.getAttribute('type') || '', length: Number(l.getAttribute('length')) || 0,
    })).filter((e) => e.url);
    const titleEl = kid(entry, 'title', ns);
    return finishItem({
      guid: txt(kid(entry, 'id', ns)),
      title: titleEl ? ((titleEl.getAttribute('type') || 'text') === 'text' ? titleEl.textContent.trim() : atomText(titleEl)) : '',
      link: atomLink(entry, 'alternate', base) || (content?.getAttribute('src') ? resolveUrl(content.getAttribute('src'), base) : ''),
      author: kids(entry, 'author', ns).map((a) => txt(kid(a, 'name', ns))).filter(Boolean).join(', ') || feedAuthor,
      published: parseDate(txt(kid(entry, 'published', ns)) || txt(kid(entry, 'issued', ns)) || txt(kid(entry, 'updated', ns)) || txt(kid(entry, 'modified', ns))),
      contentHtml,
      image: mediaImage(entry, base) || (enclosures.find((e) => e.type.startsWith('image/'))?.url || ''),
      enclosures: enclosures.filter((e) => !e.type.startsWith('image/')),
    }, base);
  });
  const titleEl = kid(root, 'title', ns);
  return {
    title: cleanTitle(titleEl ? titleEl.textContent : '') || siteUrl || url,
    siteUrl,
    description: htmlToText(txt(kid(root, 'subtitle', ns)) || txt(kid(root, 'tagline', ns))),
    iconUrl: resolveUrl(txt(kid(root, 'icon', ns)) || txt(kid(root, 'logo', ns)), feedBase),
    items,
  };
}

function parseJsonFeed(text, url) {
  let data;
  try { data = JSON.parse(text); } catch { throw new FeedParseError('Invalid JSON'); }
  if (!data || !Array.isArray(data.items) || !String(data.version || '').includes('jsonfeed')) {
    throw new FeedParseError('JSON is not a JSON Feed');
  }
  const base = data.home_page_url || url;
  return {
    title: cleanTitle(data.title) || base,
    siteUrl: resolveUrl(data.home_page_url, url),
    description: data.description || '',
    iconUrl: resolveUrl(data.icon || data.favicon, url),
    items: data.items.map((it) => {
      const authors = it.authors || (it.author ? [it.author] : data.authors || (data.author ? [data.author] : []));
      const contentHtml = it.content_html
        || (it.content_text ? `<p>${escapeHtml(it.content_text).replace(/\n\s*\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>` : '')
        || (it.summary ? `<p>${escapeHtml(it.summary)}</p>` : '');
      return finishItem({
        guid: String(it.id ?? it.url ?? ''),
        title: it.title || '',
        link: it.url || it.external_url,
        author: authors.map((a) => a?.name).filter(Boolean).join(', '),
        published: parseDate(it.date_published || it.date_modified),
        contentHtml,
        image: resolveUrl(it.image || it.banner_image, base),
        enclosures: (it.attachments || []).map((a) => ({ url: resolveUrl(a.url, base), type: a.mime_type || '', length: a.size_in_bytes || 0 })).filter((e) => e.url),
      }, base);
    }),
  };
}

// ---------- discovery ----------

const FEED_TYPES = /application\/(rss|atom|rdf|feed)\+xml|application\/(feed\+)?json|text\/xml|application\/xml/i;

/** Find feed links in an HTML document string. */
export function discoverFeedLinks(html, pageUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const baseHref = doc.querySelector('base[href]')?.getAttribute('href');
  const base = resolveUrl(baseHref, pageUrl) || pageUrl;
  return discoverInDocument(doc, base);
}

export function discoverInDocument(doc, base) {
  const out = [];
  const seen = new Set();
  const add = (href, title, type) => {
    const url = resolveUrl(href, base);
    if (!url || !/^https?:/.test(url) || seen.has(url)) return;
    seen.add(url);
    out.push({ url, title: (title || '').trim(), type: type || '' });
  };
  for (const l of doc.querySelectorAll('link[rel~="alternate" i][href], link[rel~="feed" i][href]')) {
    const type = l.getAttribute('type') || '';
    if (FEED_TYPES.test(type) || /feed/i.test(l.getAttribute('rel'))) add(l.getAttribute('href'), l.getAttribute('title'), type);
  }
  if (!out.length) {
    for (const a of doc.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href');
      if (/(^|\/)(feed|rss|atom)(\.xml|\.rss|\.json)?\/?$|\.(rss|atom)$|[?&]feed=(rss|atom)/i.test(href)) add(href, a.textContent, '');
      if (out.length >= 5) break;
    }
  }
  return out;
}

export function parseOpml(text) {
  const doc = new DOMParser().parseFromString(String(text).replace(/^﻿/, ''), 'application/xml');
  if (doc.querySelector('parsererror') || doc.documentElement.localName.toLowerCase() !== 'opml') {
    throw new FeedParseError('Not a valid OPML file');
  }
  const body = doc.querySelector('body');
  const feeds = [];
  const walk = (el, folderPath) => {
    for (const o of el.children) {
      if (o.localName !== 'outline') continue;
      const xmlUrl = o.getAttribute('xmlUrl') || o.getAttribute('xmlurl') || o.getAttribute('url');
      const title = o.getAttribute('title') || o.getAttribute('text') || '';
      if (xmlUrl && (o.getAttribute('type') || 'rss').toLowerCase() !== 'link') {
        feeds.push({ url: xmlUrl.trim(), title, siteUrl: o.getAttribute('htmlUrl') || '', folder: folderPath.join(' / ') || null });
      } else if (o.children.length) {
        walk(o, [...folderPath, title || 'Folder']);
      }
    }
  };
  if (body) walk(body, []);
  return feeds;
}
