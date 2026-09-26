import { INTENTS, PORT, browserName, clipPayload } from "./clip.js";

const CONTEXTS = ["page", "selection", "link"];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "stickyinc", title: "Stack on StickyInc", contexts: CONTEXTS });
    for (const { id, label } of INTENTS) {
      chrome.contextMenus.create({ id: `stickyinc-${id}`, parentId: "stickyinc", title: label, contexts: CONTEXTS });
    }
  });
});

/** A brief badge on the toolbar icon: ✓ stacked, ! needs attention. */
function flash(tabId, text, color) {
  chrome.action.setBadgeBackgroundColor({ tabId, color });
  chrome.action.setBadgeText({ tabId, text });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: "" }), 2500);
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const intent = String(info.menuItemId).replace(/^stickyinc-/, "");
  if (!INTENTS.some((i) => i.id === intent)) return;
  const { pairingCode } = await chrome.storage.local.get("pairingCode");
  if (!pairingCode) {
    flash(tab?.id, "!", "#c0392b");
    chrome.runtime.openOptionsPage(); // not paired yet
    return;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/clip`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${pairingCode}` },
      body: JSON.stringify(clipPayload(info, tab, intent, browserName(navigator.userAgentData?.brands))),
    });
    if (res.status === 401) {
      flash(tab?.id, "!", "#c0392b");
      chrome.runtime.openOptionsPage(); // the code changed, or was mistyped
      return;
    }
    flash(tab?.id, res.ok ? "✓" : "!", res.ok ? "#2e7d4f" : "#c0392b");
  } catch {
    flash(tab?.id, "off", "#777"); // StickyInc isn't running
  }
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
