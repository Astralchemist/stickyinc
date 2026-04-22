```
  ███████╗████████╗██╗ ██████╗██╗  ██╗██╗   ██╗    ██╗███╗   ██╗ ██████╗
  ██╔════╝╚══██╔══╝██║██╔════╝██║ ██╔╝╚██╗ ██╔╝    ██║████╗  ██║██╔════╝
  ███████╗   ██║   ██║██║     █████╔╝  ╚████╔╝     ██║██╔██╗ ██║██║
  ╚════██║   ██║   ██║██║     ██╔═██╗   ╚██╔╝      ██║██║╚██╗██║██║
  ███████║   ██║   ██║╚██████╗██║  ██╗   ██║       ██║██║ ╚████║╚██████╗
  ╚══════╝   ╚═╝   ╚═╝ ╚═════╝╚═╝  ╚═╝   ╚═╝       ╚═╝╚═╝  ╚═══╝ ╚═════╝

           ┌─────────────────────────────────────────────────────────┐
           │  v0.5.0  ·  the setup-wizard release                    │
           │                                                         │
           │   ▸ one-click onboarding (pick provider, paste key)     │
           │   ▸ global ⌘⇧N / Ctrl+Shift+N quick-add window          │
           │   ▸ tagged release builds for mac · win · linux         │
           └─────────────────────────────────────────────────────────┘


      ┌──────────────────────────┐        ┌──────────────────────────┐
      │ user ▸ call the dentist  │  MCP   │ ☐ call the dentist       │
      │        friday afternoon  │ ─────▶ │ ☐ email Sarah            │
      │ claude ▸ noted, adding.  │  tool  │ ☑ ship v0.5              │
      └──────────────────────────┘        │ ☐ make it stick          │
                 │                        └──────────────────────────┘
             the chat                               the pane
         evaporates at close           lives in ~/.stickyinc forever
```

<p align="center">
  <strong>v0.5.0</strong> · MIT · MCP-first · no backend, ever<br />
  <em>Bring your own LLM key — or piggyback on Claude Code, ChatGPT, Gemini, or local Ollama. Zero config either way.</em>
</p>

<p align="center">
  <a href="https://astralchemist.github.io/stickyinc/">Landing page</a> ·
  <a href="https://github.com/Astralchemist/stickyinc/releases/latest">Download</a> ·
  <a href="#the-idea">The idea</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#quickstart">Quickstart</a>
</p>

---

## The idea

Every LLM overlay on the market follows the same shape: **summon → ask → dismiss.** You pop a window, ask a thing, close it, and within an hour the answer has evaporated from your brain and the tab. The model is a disposable oracle; you are the durable storage.

StickyInc inverts that. Chats are cheap and ephemeral; the *commitment graph* you build from them over months — the promises, deadlines, quiet todos you let slip into conversation — is the part that actually compounds. Nobody was storing it.

So StickyInc does two things, and refuses to do anything else:

```
  1 ▸ catches the commitments
      ───────────────────────
      when you tell an LLM "call the dentist friday", an MCP tool
      call fires and a checkbox appears on your screen. no
      copy-paste, no "remind me later", no second tab.

  2 ▸ keeps them in front of you
      ──────────────────────────
      an 8-pixel strip lives on the right edge of your screen.
      hover to expand, click to tick off. the file behind it is
      a local SQLite database you own outright — swap LLMs, swap
      laptops, the graph comes with you.
```

Everything else — chat UI, OAuth flows, cloud sync, a mobile app — is *intentionally* out of scope. StickyInc is a reification layer. The LLM is the CPU; the pane is the canvas.

---

## Architecture

```
 ┌──────────────────┐    MCP stdio    ┌──────────────────┐
 │  Claude Desktop  │ ───tool call──▶ │  StickyInc MCP   │
 │   Claude Code    │                 │   (Node, stdio)  │
 │   any MCP host   │                 └────────┬─────────┘
 └──────────────────┘                          │ SQL
                                               ▼
                                 ┌─────────────────────────┐
                                 │ ~/.stickyinc/tasks.db   │
                                 │    (SQLite, yours)      │
                                 └─────────────┬───────────┘
                                               │ notify-rs watcher
                                               ▼
                                    ┌────────────────────┐
                                    │   Pane (Tauri)     │
                                    │ edge-strip, always │
                                    │ on top, translucent│
                                    └────────────────────┘
```

Claude never talks to the pane directly. They share state through SQLite — one source of truth, nothing to sync, no IPC to break.

---

## Install

Pre-built binaries ship from every tagged release. Signed and notarized builds arrive in v0.6 (see [SIGNING.md](./SIGNING.md) for the plan).

| Platform | File | Notes |
|---|---|---|
| macOS (Apple Silicon) | `StickyInc_0.5.0_aarch64.dmg` | ad-hoc signed; Gatekeeper will warn |
| Windows (x64) — installer | `StickyInc_0.5.0_x64-setup.exe` | NSIS, unsigned — SmartScreen will warn |
| Windows (x64) — MSI | `StickyInc_0.5.0_x64_en-US.msi` | for group-policy deployment |
| Linux (Debian/Ubuntu) | `StickyInc_0.5.0_amd64.deb` | `sudo dpkg -i` |
| Linux (RPM/Fedora) | `StickyInc-0.5.0-1.x86_64.rpm` | `sudo rpm -i` |
| Linux (portable) | `StickyInc_0.5.0_amd64.AppImage` | `chmod +x` and run |

> **[Grab the latest release →](https://github.com/Astralchemist/stickyinc/releases/latest)**

First launch pops a one-minute setup wizard: pick an LLM provider, paste a key, confirm the MCP registration. No terminal commands.

---

## Quickstart

Already have an installer running? Open any Claude Desktop or Claude Code session and say:

> *I need to call the dentist Friday afternoon.*

The task appears in your pane before Claude finishes its reply.

### Quick-add without a chat

While the pane is running, press **⌘⇧N** (macOS) or **Ctrl+Shift+N** (Windows/Linux). A centered input appears — type, hit Enter, done. Inline dates work: `buy bread due:2026-04-25`.

---

## MCP tools

| Tool | What it does |
|---|---|
| `add_task` | Add a todo. Optional `due_at` (ISO date). |
| `add_task_natural` | Parse free text ("*call dentist Friday 3pm*") via the configured LLM. |
| `list_tasks` | Return open tasks; silently appends `Done today (N)` so Claude has state continuity. |
| `list_done` | Return recently completed tasks, optional archive. |
| `complete_task` | Mark a task done. |
| `schedule_event` | Create a dated local task. Calendar sync is deferred to Claude's own connector (see below). |

---

## LLM providers

`add_task_natural` and the passive extraction daemon work with any of:

| Provider | How it authenticates | Detected via | Default model |
|---|---|---|---|
| **Claude Code** — your Claude Max / Pro subscription, *no API key* | local `claude` CLI OAuth | `claude` on `$PATH` | `haiku` |
| **Codex (ChatGPT)** — your ChatGPT Plus / Pro / Team subscription, *no API key* | local `codex` CLI OAuth | `codex` on `$PATH` | whatever `codex` defaults to |
| **Gemini** — your Google account (Gemini Advanced quota or free tier), *no API key* | local `gemini` CLI OAuth | `gemini` on `$PATH` | whatever `gemini` defaults to |
| **Local (Ollama / LM Studio)** — fully offline, free, no cloud call at all | — | `:11434` or `:1234` responding | first installed model |
| **OpenRouter** — one key, ~200 models, cheapest per token | API key | `OPENROUTER_API_KEY` | `anthropic/claude-3.5-haiku` |
| **Anthropic** (direct) | API key ([console.anthropic.com](https://console.anthropic.com/)) | `ANTHROPIC_API_KEY` | `claude-haiku-4-5-20251001` |
| **OpenAI** (direct) | API key ([platform.openai.com](https://platform.openai.com/api-keys)) | `OPENAI_API_KEY` | `gpt-4o-mini` |
| **OpenAI-compatible** (Groq, Together, Fireworks, vLLM…) | API key | config file | — |

### Zero-config path

Whatever you already pay for, StickyInc will use it. If any of these are set up on your machine, no key or config is needed:

- **Claude Code** (`claude` CLI) — bills to your Claude Max / Pro subscription
- **OpenAI Codex CLI** (`codex`) — bills to your ChatGPT Plus / Pro / Team subscription
- **Gemini CLI** (`gemini`) — uses your Google account (Gemini Advanced if you have it)
- **Ollama** or **LM Studio** running locally — fully free, no cloud round-trip

Each subscription CLI call shells out to the tool's print mode (`claude -p` / `codex exec` / `gemini -p`); expect ~1s of subprocess startup per parse. Local-server calls are direct HTTP and cost nothing. Prefer an API key anyway? `export OPENROUTER_API_KEY=sk-or-...` and it wins over auto-detect.

### Resolution priority

```
  1 · ~/.stickyinc/llm.json   (explicit provider wins)
  2 · OPENROUTER_API_KEY
  3 · ANTHROPIC_API_KEY
  4 · OPENAI_API_KEY
  5 · claude  CLI on PATH    →  Claude Code subscription
  6 · codex   CLI on PATH    →  ChatGPT subscription (via Codex)
  7 · gemini  CLI on PATH    →  Google / Gemini Advanced
  8 · localhost :11434/:1234 →  Ollama / LM Studio
```

### Config file examples — `~/.stickyinc/llm.json`

```json
{ "provider": "claude-code" }
```
```json
{ "provider": "claude-code", "model": "sonnet" }
```
```json
{ "provider": "codex" }
```
```json
{ "provider": "gemini", "model": "gemini-2.5-flash" }
```
```json
{ "provider": "local" }
```
```json
{ "provider": "openrouter", "model": "openai/gpt-4.1-mini" }
```
```json
{ "provider": "anthropic", "model": "claude-sonnet-4-6" }
```
```json
{ "provider": "compat", "base_url": "http://localhost:11434/v1", "model": "llama3.2", "api_key": "ollama" }
```

Override the model on any env-var or auto-detect path with `STICKYINC_MODEL=…`.

### A note on subscription-mode tradeoffs

Both `claude-code` and `codex` providers run a subprocess per call (~500ms–1s of overhead) and share the user's subscription rate limits. For interactive quick-add and the once-per-turn passive daemon this is imperceptible; if you end up in a tight extraction loop, configure a direct API provider instead. Subscription routes also mean StickyInc never touches your auth tokens — they stay in whatever state directory the CLI manages (`~/.claude/`, `~/.codex/`).

---

## Passive extraction (opt-in)

A daemon that tails your Claude Code transcripts and auto-surfaces commitments you mention in passing.

```bash
export OPENROUTER_API_KEY=sk-or-...
cd ~/stickyinc && pnpm watch
```

- Watches `~/.claude/projects/**/*.jsonl` (Claude Code session files).
- For each new **user** turn (add `--assistant` to include Claude's turns), calls the configured LLM to extract commitments.
- De-dupes via content fingerprint — "*call the dentist*" won't insert twice if still open.
- Ignores hypotheticals and past tense. Empty extractions are free (no DB write).

**Privacy:** every watched turn is sent to your configured LLM provider. Off by default; you decide when to turn it on.

---

## Calendar — by design, we defer to Claude

StickyInc intentionally doesn't ship its own Google OAuth flow. It's the single hardest setup step in the entire product surface, and Claude Desktop already has a battle-tested Google Calendar connector built in.

When you want a real calendar event, ask Claude in the same turn. `schedule_event` stores the dated task in StickyInc; Claude creates the calendar entry via its own connector. One less thing for you to set up, one less place your tokens live.

---

## Design axioms

```
  ┌─ BYO LLM key / subscription ───────────────────────────────┐
  │  no backend, no token costs on our side, no rate-limit     │
  │  theatre. whatever key you already have, we use.           │
  └────────────────────────────────────────────────────────────┘
  ┌─ client-side only ─────────────────────────────────────────┐
  │  conversations never leave your device except to the       │
  │  provider you chose. everything else is local.             │
  └────────────────────────────────────────────────────────────┘
  ┌─ local SQLite ─────────────────────────────────────────────┐
  │  ~/.stickyinc/tasks.db. sync via iCloud / Dropbox /        │
  │  Syncthing if you want. or don't. the file is yours.       │
  └────────────────────────────────────────────────────────────┘
  ┌─ MCP-first ────────────────────────────────────────────────┐
  │  StickyInc doesn't build a chat UI. it's the canvas        │
  │  Claude writes to.                                         │
  └────────────────────────────────────────────────────────────┘
  ┌─ one source of truth ──────────────────────────────────────┐
  │  the DB. pane and MCP both read/write it; no IPC           │
  │  between them; nothing to keep in sync.                    │
  └────────────────────────────────────────────────────────────┘
```

---

## Dev (running from source)

```bash
git clone https://github.com/Astralchemist/stickyinc
cd stickyinc
pnpm install
pnpm dev              # MCP server (stdio)

# in another terminal
cd pane
pnpm install
pnpm tauri:dev        # pane (edge-strip, always on top)
```

**Linux dev deps** (Ubuntu 22.04+):
```bash
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libxdo-dev libssl-dev build-essential curl wget file
```

macOS and Windows need only Rust + Node. Release builds run through GitHub Actions — see `.github/workflows/build.yml`.

---

## How the pane actually works

- Always-on-top, transparent, frameless, `skipTaskbar`. 8px strip glued to the right edge by default.
- Hover → window resizes to 320px, pane slides in. Click-through everywhere else.
- Checkbox click → Rust `complete_task` command → SQLite UPDATE → `notify-rs` watcher emits `tasks-changed` → UI re-fetches.
- Red dot on the strip when any open task is past its `due_at`.
- Reads/writes the same `~/.stickyinc/tasks.db` as the MCP server. One source of truth.

---

## Roadmap

```
  [x] v0.1   MCP server, SQLite, four tools.
  [x] v0.2   Tauri edge-strip pane.
  [x] v0.3   Recently-done + Archive drawer, list_done, CI,
             LLMProvider (Anthropic + OpenRouter + OpenAI-compat),
             add_task_natural.
  [x] v0.4   Passive extraction daemon, fingerprint dedup,
             done-today feedback in list_tasks.
  [x] v0.5   Global ⌘⇧N quick-add window, full icon set,
             one-click setup wizard, tagged release builds
             for macOS / Windows / Linux.
  [ ] v0.6   Signed + notarized macOS installer, signed MSI
             on Windows (see SIGNING.md), auto-updater,
             menu-bar quick-add.
  [ ] v0.7   Per-project tasks (separate DBs per Claude Code
             workspace), weekly digest.
```

---

## License

MIT. Do what you want.
