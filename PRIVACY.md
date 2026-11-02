# Tributary RSS Reader — Privacy Policy

_Last updated: November 2, 2026_

Tributary is a browser extension that reads RSS, Atom and JSON feeds. It is designed to work without any server operated by its developer.

## What data Tributary handles

- **Your subscriptions, folders, rules and settings**, and **the posts it downloads** from the feeds you subscribe to.
- All of this is stored **locally in your browser** (IndexedDB and `chrome.storage.local`).

## What leaves your device

- **Requests to the feeds and websites you choose.** Tributary downloads the feeds you subscribe to, and — when you ask for it — the full article page or a site's favicon, directly from those websites. Those websites see these requests the same way they would see a normal visit from your browser (including your IP address, and cookies you already have for those sites).
- **Chrome sync (optional, on by default).** If enabled, your subscription list (feed URLs, titles, folder names) and your rules are saved to `chrome.storage.sync`, which Google syncs between the Chrome browsers signed into your Google account. This is governed by Google's privacy policy. It can be switched off in *Settings → Sync*. Note that private feed URLs containing a username and password are synced as-is.

## What Tributary does **not** do

- No analytics, telemetry, advertising, or tracking of any kind.
- No accounts, and no data is sent to the developer.
- Your browsing history is not collected. On pages you visit, Tributary only checks the page for advertised feed links (`<link rel="alternate">`) to show the "feed available" indicator; this check happens locally and can be turned off in *Settings → General*.
- No data is sold or transferred to third parties.

## Deleting your data

Use *Settings → General → Delete all data*, or simply uninstall the extension, which removes everything stored locally. Synced data is removed from Chrome sync when you uninstall or turn sync off and clear it in your Google account's Chrome sync settings.

## Contact

Questions: open an issue on the project's GitHub repository.
