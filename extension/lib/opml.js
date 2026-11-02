// OPML export (pure string building; import parsing lives in feedparse.js because it needs DOMParser).

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function buildOpml(feeds, folders, { title = 'Tributary subscriptions' } = {}) {
  const outline = (f, indent) => {
    const name = f.customTitle || f.title || f.url;
    return `${indent}<outline type="rss" text="${esc(name)}" title="${esc(name)}" xmlUrl="${esc(f.url)}"${f.siteUrl ? ` htmlUrl="${esc(f.siteUrl)}"` : ''}/>`;
  };
  const sortFeeds = (list) => [...list].sort((a, b) => (a.customTitle || a.title || '').localeCompare(b.customTitle || b.title || ''));
  const folderIds = new Set(folders.map((f) => f.id));
  const lines = [];
  for (const folder of [...folders].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name))) {
    const inFolder = sortFeeds(feeds.filter((f) => f.folderId === folder.id));
    lines.push(`    <outline text="${esc(folder.name)}" title="${esc(folder.name)}">`);
    inFolder.forEach((f) => lines.push(outline(f, '      ')));
    lines.push('    </outline>');
  }
  sortFeeds(feeds.filter((f) => !f.folderId || !folderIds.has(f.folderId))).forEach((f) => lines.push(outline(f, '    ')));
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>${esc(title)}</title>
    <dateCreated>${new Date().toUTCString()}</dateCreated>
  </head>
  <body>
${lines.join('\n')}
  </body>
</opml>
`;
}
