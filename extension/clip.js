// What a clip sends to StickyInc: pure, so it can be tested outside the browser.

/** The desktop app's clipper endpoint listens here (pane/src-tauri/src/clip_server.rs). */
export const PORT = 47827;

/** What you mean to do about the page: the submenu under "Stack on StickyInc". */
export const INTENTS = [
  { id: "read", label: "Read" },
  { id: "reply", label: "Reply" },
  { id: "review", label: "Review" },
  { id: "decide", label: "Decide" },
];

/**
 * The clip for a context-menu click: the link if you right-clicked one,
 * otherwise the page, with any selected text as the excerpt.
 */
export function clipPayload(info, tab, intent, browser) {
  const onLink = Boolean(info.linkUrl);
  return {
    url: onLink ? info.linkUrl : info.pageUrl || tab?.url,
    // A link's page title isn't known without visiting it; the app falls back to the address.
    title: onLink ? info.linkText || undefined : tab?.title,
    excerpt: info.selectionText || undefined,
    intent,
    browser,
  };
}

/** "Chrome", "Edge", "Brave"…: shown in StickyInc as where the clip came from. */
export function browserName(brands = []) {
  const names = brands.map((b) => b.brand);
  for (const [brand, name] of [
    ["Microsoft Edge", "Edge"],
    ["Brave", "Brave"],
    ["Opera", "Opera"],
    ["Vivaldi", "Vivaldi"],
    ["Google Chrome", "Chrome"],
  ]) {
    if (names.includes(brand)) return name;
  }
  return "Chrome";
}
