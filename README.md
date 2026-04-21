# StickyInc

A reification layer between LLM conversations and your commitments.

Chats evaporate. StickyInc makes the decisions stick: tasks, dates, done.

## What it is

- An **MCP server** that Claude (and any MCP-capable LLM) can write tasks to.
- A local **SQLite store** at `~/.stickyinc/tasks.db` — yours, client-side, no backend.
- (v0.2, next) A floating **edge-strip pane** that renders the tasks and lets you tick them off.

## Architecture

```
Claude Desktop ──(MCP tool call)──▶ StickyInc MCP ──▶ ~/.stickyinc/tasks.db ◀── Pane (v0.2)
```

The pane is a pure view + interaction layer. Claude never talks to the pane directly — they share state through SQLite.

## Tools exposed over MCP

| Tool | Purpose |
|---|---|
| `add_task` | Add a todo. Optional `due_at` (ISO date). |
| `add_task_natural` | Parse free text ("call dentist Friday 3pm") into a task via the configured LLM. |
| `list_tasks` | Return open tasks; silently appends "Done today (N)" so the next turn knows the state. |
| `list_done` | Return recently completed tasks, with optional archive. |
| `complete_task` | Mark a task done. |
| `schedule_event` | Create a dated local task. (Calendar sync is deferred to Claude's own connector — see below.) |

## Passive extraction (v0.4)

Opt-in daemon that watches your Claude Code transcripts and auto-surfaces commitments you mention in passing.

```bash
export OPENROUTER_API_KEY=sk-or-...
cd ~/stickyinc && pnpm watch
```

- Tails `~/.claude/projects/**/*.jsonl` (Claude Code session files).
- For each new **user** turn (add `--assistant` to include Claude's turns too), calls the configured LLM to extract commitments.
- De-duplicates via content fingerprint — "call the dentist" won't insert twice if the task is still open.
- Ignores hypotheticals and past tense. Empty extractions are free (no DB write).
- **Privacy**: every watched turn is sent to your configured LLM provider. The watcher doesn't run by default; you decide when to turn it on.

## Quick-add hotkey (v0.5)

While the pane is running, press **⌘⇧N** (macOS) or **Ctrl+Shift+N** (Windows/Linux). A small centered input appears — type, hit Enter, done.

Inline dates work: `buy bread due:2026-04-25` schedules it. For anything fancier, use `add_task_natural` from Claude.

## First time use — one click

Download the installer for your OS from the [latest release](https://github.com/Astralchemist/stickyinc/releases), open it, and follow the on-screen setup wizard.

The wizard:

1. **Pick your LLM** — Claude (direct), Claude via OpenRouter (cheapest), GPT, or any OpenAI-compatible URL. Paste key.
2. **Validates the key** with a 1-token ping so you find out now, not later.
3. **Registers with Claude Code** — previews the exact JSON block it's about to add to `~/.claude.json` and asks for confirmation. No silent writes, no terminal commands.
4. **Optionally** turns on passive commitment extraction.

Setup finishes in under a minute. You can re-run the wizard any time from the `setup` link in the pane footer.

## Dev (running from source)

```bash
cd ~/stickyinc
pnpm install
pnpm dev          # MCP server (stdio)
# in another terminal:
cd pane && pnpm tauri:dev
```

## LLM providers

`add_task_natural` (and any future LLM-backed tools) work with **any** of:

| Provider | Get a key | Env var | Default model |
|---|---|---|---|
| **OpenRouter** — one key, ~200 models, cheapest per token | [openrouter.ai/keys](https://openrouter.ai/keys) | `OPENROUTER_API_KEY` | `anthropic/claude-3.5-haiku` |
| **Anthropic** — direct | [console.anthropic.com](https://console.anthropic.com/) | `ANTHROPIC_API_KEY` | `claude-haiku-4-5-20251001` |
| **OpenAI** — direct | [platform.openai.com](https://platform.openai.com/api-keys) | `OPENAI_API_KEY` | `gpt-4o-mini` |
| **OpenAI-compatible** (Groq, Together, Fireworks, Ollama, vLLM…) | — | via config file | — |

**Zero config path:** just `export OPENROUTER_API_KEY=sk-or-...` and run.

**Config file path:** `~/.stickyinc/llm.json`, any of:

```json
{ "provider": "openrouter", "model": "openai/gpt-4.1-mini" }
```
```json
{ "provider": "anthropic", "model": "claude-sonnet-4-6" }
```
```json
{ "provider": "compat", "base_url": "http://localhost:11434/v1", "model": "llama3.2", "api_key": "ollama" }
```

You can also override the model for any env-var path with `STICKYINC_MODEL=…`.

**Why OpenRouter?** One credit card, access to Claude / GPT / Gemini / Llama / Mistral / DeepSeek side-by-side. Switch model without code changes. Often 30–50% cheaper than going direct for the same model. Good default for indie users who want "more for less."

## Calendar — by design, we defer to Claude

StickyInc intentionally doesn't ship its own Google OAuth flow. It's the single
hardest setup step in the entire product surface, and Claude Desktop already
has a battle-tested Google Calendar connector built in.

So: when you want a real calendar event, ask Claude in the same turn. `schedule_event`
stores the dated task in StickyInc; Claude creates the calendar entry via its own
connector. One less thing for you to set up, one less token to leak.

## Design decisions

- **BYO LLM key / subscription** — no backend, no token costs on our side.
- **Client-side only** — conversations never leave your device.
- **Local SQLite** — user syncs via iCloud/Dropbox if they want.
- **MCP-first** — StickyInc doesn't build a chat UI. It's the canvas Claude writes to.

## v0.2 — The floating pane (Tauri)

Located at `pane/`. Rust + vanilla TS.

```bash
cd ~/stickyinc/pane
pnpm install
pnpm tauri:dev     # dev (always-on-top, right-edge strip, hover to expand)
pnpm tauri:build   # production bundle
```

**Linux dev deps** (Ubuntu 25.04):
```bash
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libxdo-dev libssl-dev build-essential curl wget file
```

macOS and Windows builds need only Rust + Node. Ship to those via CI.

### How the pane works
- Always-on-top, transparent, frameless, skipTaskbar. 8px strip glued to the right edge by default.
- Hover → window resizes to 320px, pane slides in.
- Checkbox click → Rust `complete_task` command → SQLite UPDATE → watcher emits `tasks-changed` → UI re-fetches.
- Red dot on the strip when any open task is past its `due_at`.
- Same `~/.stickyinc/tasks.db` as the MCP server. One source of truth.

## Roadmap

- [x] v0.1 — MCP server, SQLite, four tools.
- [x] v0.2 — Tauri edge-strip pane.
- [x] v0.3 — Google Calendar, Recently-done + Archive drawer, `list_done` tool, GitHub Actions CI, `LLMProvider` (Anthropic + OpenRouter + OpenAI-compat), `add_task_natural`.
- [x] v0.4 — Passive extraction daemon (`pnpm watch`), fingerprint dedup, done-today feedback in `list_tasks`.
- [x] v0.5 — Global hotkey ⌘⇧N quick-add window, full icon set (macOS/Windows/Linux/iOS/Android), CI signing hooks (see [`SIGNING.md`](./SIGNING.md)).
- [ ] v0.5 — Menu-bar quick-add (⌘⇧N), icon set, signed/notarized macOS + Windows installers via CI.

## License

MIT.
