// Version of the code in this folder. Must match manifest.json "version" (a unit test checks).
//
// Unpacked extensions read their files straight from disk, so after `git pull` a newly opened page
// runs the new code while the already-running background worker keeps the old code until the
// extension is reloaded from chrome://extensions. Pages compare this value with the one the
// background reports and ask the user to reload when they differ.
export const CODE_VERSION = '1.1.1';

/** @returns {Promise<boolean>} true when the background is running different (older) code than this page */
export async function isBackgroundStale() {
  let status;
  try { status = await chrome.runtime.sendMessage({ type: 'getStatus' }); } catch { return false; }
  return !!status?.ok && status.codeVersion !== CODE_VERSION;
}

export function openExtensionsPage() {
  chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
}

/** Insert a banner asking the user to finish the update by reloading the extension. */
export function showUpdateBanner(container) {
  if (container.querySelector('.update-banner')) return;
  const bar = document.createElement('div');
  bar.className = 'update-banner';
  bar.setAttribute('role', 'alert');
  bar.innerHTML = '<span><b>Tributary was updated.</b> To finish, click the ↻ reload button on Tributary in the extensions page. Until then, adding feeds and sync may fail.</span>';
  const btn = document.createElement('button');
  btn.className = 'primary';
  btn.textContent = 'Open extensions page';
  btn.addEventListener('click', openExtensionsPage);
  bar.appendChild(btn);
  container.prepend(bar);
}
