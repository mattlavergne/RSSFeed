// Offscreen document: MV3 service workers have no DOMParser, so XML/HTML parsing happens here.
import { parseFeed, discoverFeedLinks } from './lib/feedparse.js';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  try {
    if (msg.type === 'parseFeed') sendResponse({ ok: true, feed: parseFeed(msg.text, msg.url) });
    else if (msg.type === 'discoverLinks') sendResponse({ ok: true, links: discoverFeedLinks(msg.html, msg.url) });
    else sendResponse({ ok: false, error: `Unknown offscreen message ${msg.type}` });
  } catch (e) {
    sendResponse({ ok: false, error: e?.message || String(e) });
  }
  return false;
});
