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
- **Batch open**: middle-click (or Ctrl/⌘-click, or `x`) posts to select them, then *Open all* (`Shift+O`) opens them as background tabs in list order and marks them read. The selection survives the popup closing.

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

## Install (personal use — no store, no fee)

1. Get the code onto your computer: `git clone` this repo, or on GitHub use **Code → Download ZIP** and unzip it.
   Put it somewhere permanent (e.g. `Documents/Tributary`) — Chrome loads the extension from that folder every time it starts.
2. Open `chrome://extensions` (also works in Edge `edge://extensions` and Brave `brave://extensions`).
3. Turn on **Developer mode** (toggle, top-right).
4. Click **Load unpacked** and select the **`extension`** folder inside the repo.
5. Click the puzzle-piece icon in the toolbar and **pin** Tributary.

That's it. It keeps working across browser restarts, and refreshes feeds in the background whenever Chrome is open.

**Moving from another reader:** export OPML there, then Tributary → ⚙ Settings → *Import & export* → drop the file in.

**Updating:** `git pull` (or download the ZIP again into the **same** folder), then click ↻ on Tributary's card in `chrome://extensions`. Your feeds and posts are kept.

**Several computers:** install it the same way on each. The extension ID is pinned in `manifest.json` (`key`), so it's identical everywhere regardless of folder path — that's what lets *Settings → Sync* share your subscriptions, folders and rules through your Chrome profile. Read/unread state is per computer.

**Back up occasionally:** *Settings → Import & export → Export backup*. Data lives in your Chrome profile; removing the extension deletes it.

### Good to know about unpacked extensions
- Don't delete or rename the folder — Chrome will disable the extension (re-load it and your data comes back, since the ID is pinned).
- Updates are manual (above); nothing auto-updates.
- Work/school-managed Chromebooks or browsers may block Developer mode. That's a policy on the machine, not something the extension can work around.

### If you ever want to publish it
Optional — see [docs/PUBLISHING.md](docs/PUBLISHING.md). An **unlisted** or **private** store listing is a middle ground: still the $5 one-time fee and review, but you get one-click installs and automatic updates on all your machines. `npm run package` strips the `key` field automatically, since the store assigns its own ID.

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
