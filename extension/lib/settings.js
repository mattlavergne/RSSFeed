// Settings and rules live in chrome.storage.local.

export const DEFAULT_SETTINGS = {
  theme: 'system',            // system | light | dark
  refreshMinutes: 30,         // default refresh interval for feeds
  maxPostsPerFeed: 300,       // older (non-starred) posts beyond this are pruned
  keepReadDays: 60,           // read, non-starred posts older than this are pruned (0 = keep forever)
  badge: 'unread',            // unread | none
  notifications: true,        // desktop notifications for new posts
  openMode: 'popup',          // popup | tab  (what clicking the toolbar icon does)
  linkTarget: 'background',   // background | foreground
  markReadOnOpen: true,
  markReadOnScroll: false,
  showImages: true,
  showThumbnails: true,
  fontSize: 16,
  articleFont: 'sans',        // sans | serif
  sort: 'newest',             // newest | oldest
  density: 'comfortable',     // comfortable | compact
  unreadOnly: true,           // default list filter
  pageIndicator: true,        // change toolbar icon when the current page has a feed
  syncSubscriptions: true,    // mirror subscriptions & rules to chrome.storage.sync
  markAllConfirm: true,
  middleClick: 'select',      // select | open  (middle-click on a post in the list)
  openBatchMax: 10,           // max tabs opened per "Open all" (0 = no limit)
  hideDuplicates: true,       // mark the same story from another feed as read
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export function onSettingsChanged(cb) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) cb({ ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) });
  });
}

export async function getRules() {
  const { rules } = await chrome.storage.local.get('rules');
  return Array.isArray(rules) ? rules : [];
}

export async function saveRules(rules) {
  await chrome.storage.local.set({ rules, rulesUpdatedAt: Date.now() });
}

export function applyTheme(settings, root = document.documentElement) {
  const theme = settings.theme === 'system'
    ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : settings.theme;
  root.dataset.theme = theme;
  root.style.setProperty('--article-font-size', `${settings.fontSize}px`);
  root.dataset.articleFont = settings.articleFont;
  root.dataset.density = settings.density;
}
