// Allowlist HTML sanitizer for untrusted feed content. Runs in UI pages (needs DOM).
// Builds a fresh DOM from scratch: only allowed tags/attributes are copied, URLs are
// resolved and restricted to safe schemes, everything else is unwrapped or dropped.

import { resolveUrl } from './util.js';

const ALLOWED = new Set([
  'a', 'abbr', 'acronym', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'br', 'caption',
  'center', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption',
  'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'main',
  'mark', 'ol', 'p', 'picture', 'pre', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'section', 'small', 'source', 'span',
  'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'tt',
  'u', 'ul', 'var', 'video', 'audio', 'wbr',
]);

// Removed together with their children.
const DROP = new Set([
  'script', 'style', 'noscript', 'template', 'object', 'embed', 'applet', 'form', 'input', 'button', 'select',
  'textarea', 'option', 'link', 'meta', 'base', 'head', 'title', 'svg', 'math', 'canvas', 'frameset', 'frame',
  'dialog', 'portal', 'slot',
]);

const GLOBAL_ATTRS = new Set(['title', 'lang', 'dir', 'alt']);
const TAG_ATTRS = {
  a: ['href'],
  img: ['src', 'srcset', 'width', 'height', 'alt', 'sizes'],
  source: ['src', 'srcset', 'type', 'media', 'sizes'],
  video: ['src', 'poster', 'controls', 'width', 'height', 'loop', 'muted', 'playsinline'],
  audio: ['src', 'controls', 'loop'],
  td: ['colspan', 'rowspan', 'align'], th: ['colspan', 'rowspan', 'align', 'scope'],
  col: ['span'], colgroup: ['span'],
  ol: ['start', 'reversed', 'type'], li: ['value'],
  blockquote: ['cite'], q: ['cite'], del: ['cite', 'datetime'], ins: ['cite', 'datetime'],
  time: ['datetime'], details: ['open'], abbr: ['title'],
};
const URL_ATTRS = new Set(['href', 'src', 'poster', 'cite']);

function safeUrl(value, base, { allowData = false, allowMail = false } = {}) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (allowData && /^data:image\/(png|gif|jpe?g|webp|avif);base64,/i.test(v)) return v;
  if (v.startsWith('#')) return v;
  const abs = resolveUrl(v, base);
  if (/^https?:\/\//i.test(abs)) return abs;
  if (allowMail && /^mailto:/i.test(abs)) return abs;
  return '';
}

function safeSrcset(value, base) {
  return String(value || '').split(',').map((part) => {
    const [u, ...rest] = part.trim().split(/\s+/);
    const url = safeUrl(u, base);
    return url ? [url, ...rest].join(' ') : '';
  }).filter(Boolean).join(', ');
}

/**
 * @param {string} html
 * @param {object} opts
 * @param {string} opts.baseUrl     resolve relative URLs against this
 * @param {boolean} [opts.images]   keep images (default true)
 * @returns {DocumentFragment}
 */
export function sanitizeHtml(html, { baseUrl = '', images = true } = {}) {
  const src = new DOMParser().parseFromString(`<!doctype html><body>${html || ''}`, 'text/html');
  const out = document.createDocumentFragment();

  const walk = (node, parent) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) { parent.appendChild(document.createTextNode(child.data)); continue; }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = child.localName;
      if (DROP.has(tag)) continue;

      if (tag === 'iframe') {
        // Embedded players can't run in an extension page; offer a link instead.
        const url = safeUrl(child.getAttribute('src'), baseUrl);
        if (url) {
          const p = document.createElement('p');
          p.className = 'embed-placeholder';
          const a = document.createElement('a');
          a.href = url;
          a.textContent = `▶ Open embedded content (${new URL(url).hostname})`;
          p.appendChild(a);
          parent.appendChild(p);
        }
        continue;
      }
      if (!ALLOWED.has(tag)) { walk(child, parent); continue; } // unwrap unknown tags, keep their text
      if ((tag === 'img' || tag === 'picture') && !images) continue;

      const el = document.createElement(tag);
      const allowed = TAG_ATTRS[tag] || [];
      for (const attr of Array.from(child.attributes)) {
        const name = attr.name.toLowerCase();
        if (!GLOBAL_ATTRS.has(name) && !allowed.includes(name)) continue;
        let value = attr.value;
        if (URL_ATTRS.has(name)) {
          value = safeUrl(value, baseUrl, { allowData: tag === 'img', allowMail: tag === 'a' });
          if (!value) continue;
        } else if (name === 'srcset') {
          value = safeSrcset(value, baseUrl);
          if (!value) continue;
        }
        el.setAttribute(name, value);
      }

      if (tag === 'img') {
        // Lazy-loaded images often keep the real URL in data-src.
        if (!el.getAttribute('src')) {
          const lazy = safeUrl(child.getAttribute('data-src') || child.getAttribute('data-lazy-src') || child.getAttribute('data-original'), baseUrl);
          if (!lazy) continue;
          el.setAttribute('src', lazy);
        }
        const w = Number(el.getAttribute('width')), h = Number(el.getAttribute('height'));
        if ((w && w <= 2) || (h && h <= 2)) continue; // tracking pixel
        el.setAttribute('loading', 'lazy');
        el.setAttribute('referrerpolicy', 'no-referrer');
        el.setAttribute('decoding', 'async');
      }
      if (tag === 'a') {
        el.setAttribute('rel', 'noopener noreferrer');
        el.setAttribute('target', '_blank');
      }
      if (tag === 'video' || tag === 'audio') {
        el.setAttribute('controls', '');
        el.setAttribute('preload', 'none');
      }
      walk(child, el);
      parent.appendChild(el);
    }
  };
  walk(src.body, out);
  return out;
}
