import { existsSync, readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { addTaskUnique } from "./db.js";
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
  due_at: string | null;
}

const EXTRACTION_SYSTEM = `You extract actionable commitments from a message.

A "commitment" is something the speaker said they will or should do. Examples:
  - "I need to call the dentist" → { "text": "Call the dentist", "due_at": null }
  - "Let me email Sarah tomorrow" → { "text": "Email Sarah", "due_at": "<tomorrow UTC>" }

Ignore:
  - Hypotheticals ("I could do X")
  - Rhetorical or past-tense references
  - Generic questions or musings

Output ONLY a JSON object, no prose:
{ "commitments": [{ "text": "...", "due_at": "<ISO 8601 UTC or null>" }] }

Empty array if nothing qualifies. Relative dates resolve against the "Current time" you are given. If a date has no time, default to 09:00 local → UTC.`;

function stripFences(s: string): string {
  return s.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
}

function parseCommitments(raw: string): Commitment[] {
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
    const due = (c as { due_at?: unknown }).due_at;
    if (typeof text === "string" && text.trim().length > 0) {
      out.push({
        text: text.trim(),
        due_at: typeof due === "string" && due.length > 0 ? due : null,
      });
    }
  }
  return out;
}

async function extract(provider: LLMProvider, speaker: string, text: string): Promise<Commitment[]> {
  if (text.trim().length < 4) return [];
  const now = new Date().toISOString();
  const res = await provider.chat({
    system: EXTRACTION_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Current time: ${now}\nSpeaker: ${speaker}\n\nMessage:\n${text.slice(0, 4000)}`,
      },
    ],
    response_format: "json",
    max_tokens: 400,
    temperature: 0,
  });
  return parseCommitments(res.content);
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
}

export async function runWatcher(opts: WatcherOptions = {}): Promise<void> {
  const interval = opts.intervalMs ?? 3000;
  const includeUser = opts.includeUser ?? true;
  const includeAssistant = opts.includeAssistant ?? false;
  const verbose = opts.verbose ?? true;

  const provider = resolveLLMProvider();
  if (!provider) {
    console.error(
      "No LLM configured. Either install Claude Code or the OpenAI Codex CLI and sign in " +
        "(StickyInc will use your subscription automatically), or set OPENROUTER_API_KEY, " +
        "ANTHROPIC_API_KEY, or OPENAI_API_KEY, or create ~/.stickyinc/llm.json.",
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

      const content = readFileSync(file, "utf8");
      const slice = content.slice(prev.size);
      prev.size = st.size;
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

        try {
          const commitments = await extract(provider, role ?? "user", text);
          for (const c of commitments) {
            const { task, inserted } = addTaskUnique(c.text, c.due_at, "passive-extract");
            if (inserted && verbose) {
              console.error(`  + #${task.id} ${c.text}${c.due_at ? ` (due ${c.due_at})` : ""}`);
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

  while (!stopping) {
    try {
      await tick();
    } catch (err) {
      if (verbose) console.error(`  ! tick error: ${err instanceof Error ? err.message : err}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
