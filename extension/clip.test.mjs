import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { INTENTS, PORT, browserName, clipPayload } from "./clip.js";

const tab = { url: "https://example.com/q3", title: "Q3 budget thread" };

test("a page clip sends the page, its title and the selection", () => {
  const info = { pageUrl: "https://example.com/q3", selectionText: "Numbers by Monday?" };
  assert.deepEqual(clipPayload(info, tab, "reply", "Chrome"), {
    url: "https://example.com/q3", title: "Q3 budget thread", excerpt: "Numbers by Monday?", intent: "reply", browser: "Chrome",
  });
});

test("a link clip sends the link, not the page it's on", () => {
  const info = { pageUrl: "https://example.com/q3", linkUrl: "https://docs.example.com/plan" };
  const clip = clipPayload(info, tab, "read", "Edge");
  assert.equal(clip.url, "https://docs.example.com/plan");
  assert.equal(clip.title, undefined, "not the page's title");
  assert.equal(clip.excerpt, undefined);
});

test("the browser is named from its brands", () => {
  assert.equal(browserName([{ brand: "Chromium" }, { brand: "Microsoft Edge" }]), "Edge");
  assert.equal(browserName([{ brand: "Chromium" }, { brand: "Google Chrome" }]), "Chrome");
  assert.equal(browserName(undefined), "Chrome");
});

test("the intents and port match the app", () => {
  assert.deepEqual(INTENTS.map((i) => i.id), ["read", "reply", "review", "decide"]);
  const server = readFileSync(new URL("../pane/src-tauri/src/clip_server.rs", import.meta.url), "utf8");
  assert.match(server, new RegExp(`pub const PORT: u16 = ${PORT};`));
  for (const { id } of INTENTS) assert.match(server, new RegExp(`"${id}" =>`));
  const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.host_permissions, [`http://127.0.0.1:${PORT}/*`]);
});
