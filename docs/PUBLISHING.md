# Publishing Tributary to the Chrome Web Store

Publishing a free extension is allowed and common. You pay Google a **one-time US $5 developer registration fee**; there's no yearly fee and no cost per extension. Expect the whole process to take an hour of your time plus a review wait (usually a few days; extensions with broad host permissions like this one can get an "in-depth review" that takes longer).

> Store rules change from time to time. If a screen looks different from what's described here, the official guide is at <https://developer.chrome.com/docs/webstore/publish>.

---

## 0. Before you start — decisions to make

1. **Name & branding.** The extension is called *Tributary*. You can rename it in `extension/manifest.json` (`name`, `short_name`, `action.default_title`). **Do not** use "Feeder" (or any other product's name, logo or screenshots) in the name, icon, description or keywords — the Web Store removes listings that impersonate other products.
2. **A public privacy-policy URL.** The store asks for one. `PRIVACY.md` in this repo is ready to use, but the link must be public. Options:
   - Make this GitHub repository public and link to `https://github.com/<you>/<repo>/blob/main/PRIVACY.md`, or
   - Keep the repo private and paste `PRIVACY.md` into a public GitHub Gist, Google Doc ("anyone with the link"), or GitHub Pages site.
3. **A support contact.** An email address shown on the listing (can be a dedicated address).

## 1. Create a developer account (one time)

1. Sign in to the Google account you want to publish under (consider a dedicated one).
2. Turn on **2-Step Verification** for that account — publishing requires it: <https://myaccount.google.com/signinoptions/two-step-verification>.
3. Go to the developer dashboard: <https://chrome.google.com/webstore/devconsole>.
4. Accept the developer agreement and pay the **$5 registration fee**.
5. In **Account**, set your publisher display name and contact email, and **verify the email** (Google sends a link).
6. You'll be asked whether you are a **"trader"** (an EU consumer-law declaration). If you're publishing a free hobby project and not as a business, you'd normally declare **non-trader**. If unsure, read the explanation on that screen.

## 2. Build the upload package

```bash
npm run package
```

This creates `dist/tributary-1.0.0.zip` containing everything in `extension/` (with `manifest.json` at the zip root, which is what the store requires). No `npm install` is needed for this step.

## 3. Create the item

1. In the dashboard click **➕ New item** and upload the zip.
2. You land on the item's draft. Fill in the tabs below.

### Store listing tab

| Field | What to enter |
|---|---|
| Description | Paste the text from [`docs/store/listing.md`](store/listing.md) |
| Category | **Productivity → Tools** (or *Lifestyle → News & Weather*; pick what the dashboard offers) |
| Language | English |
| Store icon | `docs/store/icon512.png` is the source; the dashboard wants **128×128** — upload `extension/icons/icon128.png` |
| Screenshots (1–5, **1280×800**) | `docs/store/screenshot-1-1280x800.png`, `screenshot-2-…`, `screenshot-3-…` |
| Small promo tile (**440×280**) | `docs/store/promo-small-440x280.png` |
| Marquee / large promo | Optional — skip |
| Official URL / homepage | Your GitHub repo URL (optional) |
| Support URL | Your repo's Issues page or your email |

### Privacy practices tab

**Single purpose description** (paste):

> Tributary is an RSS/Atom/JSON feed reader: it lets the user subscribe to website feeds, fetches new posts in the background, and displays them for reading.

**Permission justifications** (paste each into its box):

| Permission | Justification |
|---|---|
| `storage` | Saves the user's settings, rules and sync data. |
| `unlimitedStorage` | Feed posts are stored locally in IndexedDB so they can be read offline; users with many feeds exceed the default quota. |
| `alarms` | Periodically checks the user's feeds for new posts on the schedule the user chose. |
| `notifications` | Shows desktop notifications for new posts and for the user's keyword alerts. Can be turned off. |
| `offscreen` | Manifest V3 service workers have no DOMParser; an offscreen document is used solely to parse feed XML and HTML. |
| `contextMenus` | Adds "Subscribe to this page/link in Tributary" and reader actions to right-click menus. |
| `scripting` | Reads `<link rel="alternate">` feed links from the current page so the user can subscribe in one click, and to show a "feed available" indicator. Nothing on the page is changed. |
| `favicon` | Shows website icons next to feeds using Chrome's local favicon cache. |
| Host permission `<all_urls>` | An RSS reader must download feeds from whatever websites the user subscribes to, which can be any domain. Also used to fetch the full article when the user asks for it and to detect feeds on the page the user is viewing. No data is collected or sent anywhere else. |

**Are you using remote code?** → **No, I am not using remote code.** (All JavaScript ships inside the package; feed content is sanitized and never executed.)

**Data usage** — tick the boxes honestly. With the default code nothing is sent to you, so the usual answer is that the extension does **not collect** any of the listed data types. (Website content is downloaded and stored only on the user's device.) Then tick all three certifications:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL** → the public link from step 0.

### Distribution tab

- **Payments:** Free.
- **Visibility:** *Public* (anyone can find it), *Unlisted* (only people with the link — nice for a soft launch), or *Private* (only testers you list).
- **Regions:** All regions.

## 4. Submit

Click **Submit for review**. You'll get an email when it's approved or if something needs changing. Common rejection reasons and fixes:

- *"Excessive permissions"* — reply using the justifications above; every permission here is actually used.
- *"Missing/invalid privacy policy"* — make sure the URL is public (open it in a private window).
- *"Keyword spam / misleading"* — keep the description factual; don't list competitor names.

After approval your listing appears at `https://chromewebstore.google.com/detail/<item-id>` — that's the link to share.

## 5. Publishing updates

1. Make your changes and bump `"version"` in `extension/manifest.json` (e.g. `1.0.0` → `1.0.1`; the store rejects an upload with the same or lower version).
2. `npm test` then `npm run package`.
3. Dashboard → your item → **Package → Upload new package** → **Submit for review**.
4. Users receive the update automatically within a few hours of approval.

## Other browsers (optional)

- **Edge, Brave, Opera, Vivaldi** users can install directly from the Chrome Web Store. Edge also has its own free store (Partner Center) that accepts the same zip.
- **Firefox** would need small changes (Firefox's MV3 background page has a DOM, so the offscreen document isn't needed, and `chrome.storage.sync`/`favicon` differ). Not supported yet.
