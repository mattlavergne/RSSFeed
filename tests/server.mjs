// Tiny fixture server for end-to-end tests.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const TYPES = { '.xml': 'application/xml', '.json': 'application/feed+json', '.html': 'text/html; charset=utf-8', '.opml': 'text/x-opml' };

export function startServer() {
  const dynamic = { items: [{ id: 'd1', title: 'Dynamic first' }], version: 1 };
  const hits = {};
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    hits[url.pathname] = (hits[url.pathname] || 0) + 1;
    const base = `http://${req.headers.host}`;
    if (url.pathname === '/dynamic/add') {
      dynamic.items.unshift({ id: `d${dynamic.items.length + 1}`, title: url.searchParams.get('title') || 'New item' });
      dynamic.version++;
      return res.end('ok');
    }
    if (url.pathname === '/dynamic.xml') {
      const etag = `"v${dynamic.version}"`;
      if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/rss+xml', etag });
      const now = Date.now();
      return res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Dynamic Feed</title><link>${base}/</link>${dynamic.items.map((it, i) => `<item><title>${it.title}</title><guid>${it.id}</guid><link>${base}/article.html?${it.id}</link><pubDate>${new Date(now - i * 60000).toUTCString()}</pubDate><description>Body of ${it.title}</description></item>`).join('')}</channel></rss>`);
    }
    if (url.pathname === '/auth.xml') {
      const ok = req.headers.authorization === `Basic ${Buffer.from('user:secret').toString('base64')}`;
      if (!ok) { res.writeHead(401, { 'www-authenticate': 'Basic realm="x"' }); return res.end('no'); }
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      return res.end('<rss version="2.0"><channel><title>Private Feed</title><item><title>Secret item</title><guid>s1</guid></item></channel></rss>');
    }
    if (url.pathname === '/broken.xml') {
      res.writeHead(200, { 'content-type': 'text/xml' });
      return res.end('<?xml version="1.0"?><rss version="2.0"><channel><title>Broken & Co</title><item><title>Tom & Jerry</title><link>https://b.example/1?a=1&b=2</link><guid>b1</guid></item></channel></rss>');
    }
    if (url.pathname === '/summary.xml') {
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      return res.end(`<rss version="2.0"><channel><title>Summary Only</title><link>${base}/</link><item><title>Needs full text</title><guid>sum1</guid><link>${base}/article.html</link><description>Just a teaser…</description></item></channel></rss>`);
    }
    if (url.pathname === '/redirect') { res.writeHead(301, { location: '/atom.xml' }); return res.end(); }
    if (url.pathname === '/site/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html><head><title>No link tags</title></head><body>hi</body></html>');
    }
    if (url.pathname === '/feed') { // common path fallback for /site/
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      return res.end('<rss version="2.0"><channel><title>Guessed Feed</title><item><title>g</title><guid>g1</guid></item></channel></rss>');
    }
    const file = path.join(dir, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    let body = fs.readFileSync(file);
    if (file.endsWith('.opml')) body = body.toString().replaceAll('{{BASE}}', base);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    return res.end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({ server, base: `http://127.0.0.1:${port}`, hits, close: () => new Promise((r) => server.close(r)) });
  }));
}
