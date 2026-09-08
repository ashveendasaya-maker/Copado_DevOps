'use strict';

/*
 * The only thing that runs outside the popup.
 *
 * Its one job is to grey the toolbar icon on tabs this extension has nothing to
 * say about. Enabling and disabling the action is per-tab browser state, and a
 * popup cannot set it for the tab that is about to open it — so this has to live
 * in a worker even though nothing else here does.
 *
 * Deliberately holds no state of its own. The worker is torn down whenever
 * Chrome feels like it, so anything it needed to remember between events would
 * have to come back from storage, and there is nothing here worth remembering:
 * every listener is handed the tab it has to answer for.
 */

// Matches the host test the popup uses to resolve a session, so the icon and
// the screen behind it cannot disagree about what counts as a Salesforce tab.
const SALESFORCE_HOST = /(salesforce\.com|force\.com)$/;

function isSalesforceUrl(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && SALESFORCE_HOST.test(hostname);
  } catch {
    // chrome://, about:blank, a tab still resolving — none of them are it.
    return false;
  }
}

async function syncTab(tabId, url) {
  try {
    if (isSalesforceUrl(url)) await chrome.action.enable(tabId);
    else await chrome.action.disable(tabId);
  } catch {
    // The tab closed between the event firing and this call. Nothing to set.
  }
}

/*
 * The global default goes to disabled, and each tab is then enabled on its own
 * merits. A tab the worker has never seen is therefore grey rather than briefly
 * offering a popup that would open with nothing in it.
 */
async function syncAll() {
  await chrome.action.disable();

  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab) => syncTab(tab.id, tab.url)));
}

chrome.runtime.onInstalled.addListener(syncAll);
chrome.runtime.onStartup.addListener(syncAll);

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab) await syncTab(tab.id, tab.url);
});

/*
 * Fires for the address changing and again for the load completing. Both are
 * needed: a fresh navigation reports the URL first, while a tab restored on
 * startup can reach 'complete' without ever reporting one.
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') syncTab(tabId, tab.url);
});
