# Tributary — a free, private RSS reader for Chrome

Tributary is a browser-extension RSS reader with the features you'd normally pay for — unlimited feeds, fast refresh, keyword alerts, filters, full-article view, sync — and no account, server, or subscription. Everything runs inside your browser.

![Reader](docs/screenshots/reader.png)

| Popup | Filters & keyword alerts |
|---|---|
| ![Popup](docs/screenshots/popup.png) | ![Rules](docs/screenshots/options-rules.png) |

## Features

**Reading**
- Toolbar popup for quick reading, or a full-tab three-pane reader (choose which the toolbar button opens)
- Unread / all / starred views, folders, per-feed views, search across all posts
- Full-article extraction (Mozilla Readability) for feeds that only include summaries — on demand (`f`) or always, per feed
- Podcast/video enclosures play inline; images, thumbnails, light/dark/system theme, font size, serif/sans, compact list
- Keyboard shortcuts (`j`/`k`, `o`, `m`, `s`, `f`, `Shift+A`, `/`, `?` …) and a global shortcut to open the popup (`Alt+Shift+R`)
- Mark read on open or on scroll; "mark all as read" per feed, folder, search or everything

**Feeds**
- RSS 2.0/0.9x, RSS 1.0 (RDF), Atom and JSON Feed; tolerant of malformed XML and non-UTF-8 encodings
- Paste a website URL and Tributary finds its feeds (`<link rel="alternate">`, then common paths like `/feed`)
- The toolbar icon gets a green **+** on pages that have a feed; right-click any page or link → *Subscribe in Tributary*
- Unlimited feeds; refresh every 1 min – 1 day (global default + per-feed override), conditional GET (ETag/Last-Modified), automatic back-off for failing feeds
- Private feeds via HTTP Basic auth (`https://user:password@host/feed`) or your browser's cookies
- Drag feeds between folders, rename, pause, per-feed notification settings, error status per feed

**Power features**
- **Rules / keyword alerts**: match title, content, author or link (contains any of several keywords, does not contain, equals, or regex), scoped to all or some feeds, then *notify*, *highlight*, *star*, *mark read* or *hide*. Preview matches and apply a rule to existing posts.
- **Desktop notifications** for new posts (grouped when there are many), with *Open* / *Mark as read* buttons
- **Unread badge** on the toolbar icon
- **Sync** subscriptions, folders and rules between computers through Chrome's own sync (your Google account in Chrome — no third-party server)
- **Import/export OPML** (folders preserved, works with Feedly, Inoreader, Feeder, NetNewsWire, …) and a **full JSON backup** (feeds, per-feed settings, rules, settings, starred posts)
- Automatic cleanup: cap posts per feed and delete old read posts (starred posts are never deleted)

**Privacy**: no analytics, no accounts, no servers. Feeds are fetched directly from your browser and stored locally in IndexedDB. See [PRIVACY.md](PRIVACY.md).

## Install it yourself (2 minutes, no store needed)

1. Download this repository (green **Code** button → *Download ZIP*, then unzip) or `git clone` it.
2. Open `chrome://extensions` in Chrome (or `edge://extensions` in Edge, `brave://extensions` in Brave).
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select the **`extension`** folder inside this repo.
5. Pin Tributary from the puzzle-piece menu so the icon stays in your toolbar.

To update after pulling new code, click the ↻ reload button on Tributary's card in `chrome://extensions`. Your data is kept.

## Publishing to the Chrome Web Store

See **[docs/PUBLISHING.md](docs/PUBLISHING.md)** — a step-by-step guide including store-listing text, permission justifications and privacy answers you can paste in.

## Development

No build step: the extension is plain JavaScript modules in `extension/`.

```
extension/
  manifest.json        Manifest V3
  background.js        service worker: scheduling, fetching, rules, notifications, badge, menus, sync
  offscreen.*          offscreen document that parses XML/HTML (service workers have no DOMParser)
  popup.html/reader.html  the reader UI (same app, popup and full-tab layouts)
  options.html         settings, feed manager, rules, import/export, sync
  lib/                 db (IndexedDB), feed parser, sanitizer, rules, OPML, sync, settings
  ui/                  UI scripts and styles
tests/                 unit tests + end-to-end tests with local fixture feeds
scripts/package.mjs    builds dist/tributary-<version>.zip for the store
```

Requires Node 18+.

```bash
npm install            # only needed for the end-to-end tests (Playwright)
npx playwright install chromium
```

```bash
npm test               # unit tests + end-to-end tests (loads the real extension in Chromium)
```

```bash
npm run package        # → dist/tributary-<version>.zip
```

Set `HEADED=1` to watch the end-to-end run, and `SCREENSHOTS=1` to regenerate `docs/screenshots`.

## Limitations (honest list)

- Feeds refresh only while Chrome is running (there's no server polling for you). On startup it catches up immediately.
- Sync covers subscriptions, folders and rules — not read/unread state or post content. Chrome's sync storage is ~100 KB, which (compressed) fits a few thousand feeds.
- No mobile app. Sites that don't publish feeds (e.g. most social networks) can't be followed without a third-party feed generator.
- Embedded iframes (YouTube etc.) are shown as links, because extension pages can't safely run third-party embeds.

## License

MIT — see [LICENSE](LICENSE). Mozilla Readability (`extension/lib/vendor/Readability.js`) is Apache-2.0.
