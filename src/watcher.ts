import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { addTaskUnique } from "./db.js";
import { resolveDue, type Due } from "./dates.js";
import { cap, EXCERPT_MAX } from "./provenance.js";
import { resolveLLMProvider, type LLMProvider } from "./providers/index.js";

const CLAUDE_PROJECTS = join(homedir(), ".claude", "projects");
const STATE_FILE = join(homedir(), ".stickyinc", "watcher-state.json");

interface WatcherState {
  files: Record<string, { size: number; mtime: number }>;
}

function loadState(): WatcherState {
  if (!existsSync(STATE_FILE)) return { files: {} };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as WatcherState;
  } catch {
    return { files: {} };
  }
}

function saveState(s: WatcherState): void {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

/** Read bytes [start, end) of a file without loading the rest of it. */
function readBytes(file: string, start: number, end: number): Buffer {
  const buf = Buffer.alloc(end - start);
  const fd = openSync(file, "r");
  try {
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function listJsonlFiles(): string[] {
  if (!existsSync(CLAUDE_PROJECTS)) return [];
  const out: string[] = [];
  for (const dir of readdirSync(CLAUDE_PROJECTS)) {
    const full = join(CLAUDE_PROJECTS, dir);
    try {
      if (!statSync(full).isDirectory()) continue;
      for (const f of readdirSync(full)) {
        if (f.endsWith(".jsonl")) out.push(join(full, f));
      }
    } catch {
      // ignore unreadable project dirs
    }
  }
  return out;
}

interface TranscriptLine {
  type?: string;
  uuid?: string;
  message?: { role?: string; content?: unknown };
  timestamp?: string;
}

function extractText(message: TranscriptLine["message"]): string {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && "text" in b) return String((b as { text: unknown }).text ?? "");
        return "";
      })
      .join(" ")
      .trim();
  }
  return "";
}

interface Commitment {
  text: string;
  due: Due | null;
  /** The sentence it came from, per the model; checked by excerptFor. */
  quote: string | null;
}

const EXTRACTION_SYSTEM = `You extract actionable commitments from a message.

A "commitment" is something the speaker said they will or should do. Examples:
  - "I need to call the dentist" → { "text": "Call the dentist", "due": null, "quote": "I need to call the dentist" }
  - "Let me email Sarah tomorrow" → { "text": "Email Sarah", "due": "tomorrow", "quote": "Let me email Sarah tomorrow" }

Ignore:
  - Hypotheticals ("I could do X")
  - Rhetorical or past-tense references
  - Generic questions or musings

Output ONLY a JSON object, no prose:
{ "commitments": [{ "text": "...", "due": "<the words that say when, or null>", "quote": "<the sentence it came from, copied exactly>" }] }

Empty array if nothing qualifies. "due" copies the speaker's date/time words ("Friday 3pm", "next week"); don't work out a date. If an hour has no am/pm, add the one the speaker means.`;

function stripFences(s: string): string {
  return s.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
}

/** `said` is when the message was written; relative dates are read against it. */
function parseCommitments(raw: string, said: Date): Commitment[] {
  let cleaned = stripFences(raw);
  let obj: unknown;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return [];
    try {
      obj = JSON.parse(m[0]);
    } catch {
      return [];
    }
  }
  if (!obj || typeof obj !== "object") return [];
  const arr = (obj as { commitments?: unknown[] }).commitments;
  if (!Array.isArray(arr)) return [];
  const out: Commitment[] = [];
  for (const c of arr) {
    if (!c || typeof c !== "object") continue;
    const text = (c as { text?: unknown }).text;
    const due = (c as { due?: unknown }).due;
    const quote = (c as { quote?: unknown }).quote;
    if (typeof text === "string" && text.trim().length > 0) {
      out.push({
        text: text.trim(),
        due: typeof due === "string" && due.trim() ? resolveDue(due, said) : null,
        quote: typeof quote === "string" ? quote : null,
      });
    }
  }
  return out;
}

/**
 * The words shown as a task's provenance: the model's quote if it really is
 * in the message, so the pane never shows words nobody said; otherwise the
 * start of the message.
 */
function excerptFor(message: string, quote: string | null): string | null {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  if (quote && norm(quote) && norm(message).includes(norm(quote))) return cap(quote, EXCERPT_MAX);
  return cap(message, EXCERPT_MAX);
}

async function extract(
  provider: LLMProvider,
  speaker: string,
  text: string,
  said: Date
): Promise<Commitment[]> {
  if (text.trim().length < 4) return [];
  const res = await provider.chat({
    system: EXTRACTION_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Speaker: ${speaker}\n\nMessage:\n${text.slice(0, 4000)}`,
      },
    ],
    response_format: "json",
    max_tokens: 400,
    temperature: 0,
  });
  return parseCommitments(res.content, said);
}

interface WatcherOptions {
  /** Poll interval in milliseconds. */
  intervalMs?: number;
  /** Also extract from user turns (default true). */
  includeUser?: boolean;
  /** Also extract from assistant turns (default false — more noise, more cost). */
  includeAssistant?: boolean;
  /** Verbose logging to stderr. */
  verbose?: boolean;
  /**
   * Exit once the parent process is gone. The pane runs the watcher as a
   * child; this keeps a crashed or force-quit pane from leaving an orphan
   * that keeps sending transcripts to the LLM.
   */
  exitWithParent?: boolean;
}

export async function runWatcher(opts: WatcherOptions = {}): Promise<void> {
  const interval = opts.intervalMs ?? 3000;
  const includeUser = opts.includeUser ?? true;
  const includeAssistant = opts.includeAssistant ?? false;
  const verbose = opts.verbose ?? true;

  const provider = await resolveLLMProvider();
  if (!provider) {
    console.error(
      "No LLM configured. StickyInc auto-uses whatever is on this machine: claude / codex / gemini " +
        "CLI (subscription), Ollama or LM Studio (local), or an API key via OPENROUTER_API_KEY / " +
        "ANTHROPIC_API_KEY / OPENAI_API_KEY. Or create ~/.stickyinc/llm.json.",
    );
    process.exit(1);
  }

  if (!existsSync(CLAUDE_PROJECTS)) {
    console.error(`No Claude Code transcripts at ${CLAUDE_PROJECTS}. Is Claude Code installed?`);
    process.exit(1);
  }

  console.error(
    `StickyInc watcher running.\n` +
      `  Transcripts: ${CLAUDE_PROJECTS}\n` +
      `  Provider:    ${provider.name} (${provider.model})\n` +
      `  Extracting:  ${[includeUser && "user", includeAssistant && "assistant"].filter(Boolean).join(", ")}\n` +
      `  Poll:        ${interval}ms\n` +
      `  Press Ctrl-C to stop.\n`
  );

  const state = loadState();

  // Seed: on first run, start from END of each existing file (don't backfill history).
  for (const f of listJsonlFiles()) {
    if (!state.files[f]) {
      const st = statSync(f);
      state.files[f] = { size: st.size, mtime: st.mtimeMs };
    }
  }
  saveState(state);

  const tick = async (): Promise<void> => {
    for (const file of listJsonlFiles()) {
      let st;
      try {
        st = statSync(file);
      } catch {
        continue;
      }
      const prev = state.files[file] ?? { size: 0, mtime: 0 };

      // File shrunk (rotated/truncated) — reset
      if (st.size < prev.size) prev.size = 0;
      if (st.size === prev.size) continue;

      // `size` is a byte offset, so read bytes — slicing decoded text by it
      // skips content once the file has any multi-byte UTF-8. Stop at the
      // last newline so a line still being written is read whole next tick.
      const chunk = readBytes(file, prev.size, st.size);
      const end = chunk.lastIndexOf(0x0a) + 1;
      if (end === 0) continue;
      const slice = chunk.subarray(0, end).toString("utf8");
      prev.size += end;
      prev.mtime = st.mtimeMs;
      state.files[file] = prev;

      for (const line of slice.split("\n")) {
        if (!line.trim()) continue;
        let obj: TranscriptLine;
        try {
          obj = JSON.parse(line) as TranscriptLine;
        } catch {
          continue;
        }
        const role = obj.message?.role;
        if (obj.type !== "user" && obj.type !== "assistant") continue;
        if (role === "user" && !includeUser) continue;
        if (role === "assistant" && !includeAssistant) continue;
        const text = extractText(obj.message);
        if (!text) continue;

        // The transcript's own timestamp, not now: a backlog read after a
        // restart must take "tomorrow" from when it was said.
        const stamped = obj.timestamp ? new Date(obj.timestamp) : null;
        const said = stamped && !Number.isNaN(stamped.getTime()) ? stamped : new Date();

        try {
          const commitments = await extract(provider, role ?? "user", text, said);
          for (const c of commitments) {
            const { task, inserted } = addTaskUnique({
              text: c.text,
              due: c.due,
              source: "passive-extract",
              from: {
                client: "Claude Code",
                // The transcript file and message: enough to find it again.
                ref: obj.uuid ? `${file}#${obj.uuid}` : file,
                excerpt: excerptFor(text, c.quote),
              },
            });
            if (inserted && verbose) {
              const due = c.due ? ` (due ${c.due.at ?? "?"} from "${c.due.phrase}")` : "";
              console.error(`  + #${task.id} ${c.text}${due}`);
            } else if (!inserted && verbose) {
              console.error(`  ~ dup #${task.id} ${c.text}`);
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (verbose) console.error(`  ! extract failed: ${msg}`);
        }
      }
      saveState(state);
    }
  };

  // Loop
  let stopping = false;
  const onExit = (): void => {
    stopping = true;
    saveState(state);
    console.error("\nwatcher stopped.");
    process.exit(0);
  };
  process.on("SIGINT", onExit);
  process.on("SIGTERM", onExit);

  const parentPid = process.ppid;
  while (!stopping) {
    if (opts.exitWithParent && process.ppid !== parentPid) {
      console.error("parent exited; watcher stopping.");
      onExit();
    }
    try {
      await tick();
    } catch (err) {
      if (verbose) console.error(`  ! tick error: ${err instanceof Error ? err.message : err}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
