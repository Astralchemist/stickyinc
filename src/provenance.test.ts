import assert from "node:assert/strict";
import { test } from "node:test";
import { cap, clientLabel, EXCERPT_MAX, fromTool } from "./provenance.js";

test("excerpts collapse whitespace and keep short text whole", () => {
  assert.equal(cap("  call the\n\n dentist  ", EXCERPT_MAX), "call the dentist");
  assert.equal(cap("   ", EXCERPT_MAX), null);
  assert.equal(cap(undefined, EXCERPT_MAX), null);
});

test("long excerpts are cut to the cap, with an ellipsis", () => {
  const out = cap("word ".repeat(100), EXCERPT_MAX)!;
  assert.equal(Array.from(out).length <= EXCERPT_MAX, true);
  assert.ok(out.endsWith("word…"), out);
});

test("the cap counts characters, so an emoji isn't split in half", () => {
  const out = cap("🦷".repeat(EXCERPT_MAX + 5), EXCERPT_MAX)!;
  assert.equal(Array.from(out).length, EXCERPT_MAX);
  assert.ok(out.startsWith("🦷") && out.endsWith("🦷…"));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out), "no lone surrogate");
});

test("clients are named the way the user knows them", () => {
  assert.equal(clientLabel({ name: "claude-code", title: "Claude Code" }), "Claude Code");
  assert.equal(clientLabel({ name: "claude-ai" }), "Claude Desktop");
  assert.equal(clientLabel({ name: "cursor-vscode" }), "Cursor");
  assert.equal(clientLabel({ name: "some-new-client" }), "some-new-client");
  assert.equal(clientLabel(undefined), null);
});

test("tool context becomes provenance, capped", () => {
  assert.deepEqual(fromTool("Claude Code", { excerpt: "x".repeat(300), ref: " notes.md " }), {
    client: "Claude Code",
    ref: "notes.md",
    excerpt: "x".repeat(EXCERPT_MAX - 1) + "…",
  });
  assert.deepEqual(fromTool(null, undefined), { client: null, ref: null, excerpt: null });
});
