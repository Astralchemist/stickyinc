```
  ███████╗████████╗██╗ ██████╗██╗  ██╗██╗   ██╗    ██╗███╗   ██╗ ██████╗
  ██╔════╝╚══██╔══╝██║██╔════╝██║ ██╔╝╚██╗ ██╔╝    ██║████╗  ██║██╔════╝
  ███████╗   ██║   ██║██║     █████╔╝  ╚████╔╝     ██║██╔██╗ ██║██║
  ╚════██║   ██║   ██║██║     ██╔═██╗   ╚██╔╝      ██║██║╚██╗██║██║
  ███████║   ██║   ██║╚██████╗██║  ██╗   ██║       ██║██║ ╚████║╚██████╗
  ╚══════╝   ╚═╝   ╚═╝ ╚═════╝╚═╝  ╚═╝   ╚═╝       ╚═╝╚═╝  ╚═══╝ ╚═════╝
```

<p align="center">
  <strong>Tell Claude what you need to do. It sticks to the edge of your screen.</strong><br />
  StickyInc is an MCP server plus a thin always-on-top strip. Mention a commitment in any chat, like <em>"call the dentist Friday"</em>, and it becomes a checkbox you can see, kept in a local SQLite file you own.
</p>

<p align="center">
  <img src="docs/demo.gif" width="720" alt="A Claude chat: the user types 'I need to call the dentist Friday afternoon', and the task appears on the StickyInc strip at the right edge of the screen." />
</p>

<p align="center">
  <strong>v0.6.1</strong> · MIT · MCP-first · no backend, ever<br />
  <em>Bring your own LLM key — or piggyback on Claude Code, ChatGPT, Gemini, or local Ollama. Zero config either way.</em>
</p>

<p align="center">
  <a href="#setup">Setup</a> ·
  <a href="https://github.com/Astralchemist/stickyinc/releases/latest">Download</a> ·
  <a href="https://astralchemist.github.io/stickyinc/">Landing page</a> ·
  <a href="#the-idea">The idea</a> ·
  <a href="#architecture">Architecture</a>
</p>

---

## Setup

**1 · Add the MCP server to your client.** You need [Node.js 22.13+](https://nodejs.org); `npx` fetches StickyInc on first run.

**Claude Code**

```bash
claude mcp add -s user stickyinc -- npx -y stickyinc
```

**Claude Desktop**: Settings → Developer → Edit Config, then add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "stickyinc": { "command": "npx", "args": ["-y", "stickyinc"] }
  }
}
```

**Cursor**: add to `~/.cursor/mcp.json` (every project) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "stickyinc": { "command": "npx", "args": ["-y", "stickyinc"] }
  }
}
```

**Faster startup (optional):** `npx` asks npm for the latest StickyInc every time your client starts it, which takes 1–3 seconds. Install it once instead and it starts in about a tenth of a second: run `npm install -g stickyinc`, then use `stickyinc` as the command (`claude mcp add -s user stickyinc -- stickyinc`, or `"command": "stickyinc", "args": []`). Updates are then up to you: `npm install -g stickyinc@latest`.

Restart the client and tell it something you need to do: *"remind me to call the dentist Friday afternoon."* If Claude Desktop or Cursor can't find `npx`, put its full path (from `which npx`) in `command`.

**2 · Get the strip.** The server saves tasks to `~/.stickyinc/tasks.db`; the pane is the strip that shows them. [Install the pane](#install-the-pane) for macOS, Windows, or Linux. Its setup wizard can also do step 1 for Claude Code.

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

## Install the pane

Pre-built binaries ship from every tagged release. Builds are unsigned for now; [SIGNING.md](./SIGNING.md) has the plan for signed and notarized ones.

| Platform | File | Notes |
|---|---|---|
| macOS (Apple Silicon) | `StickyInc_<version>_aarch64.dmg` | ad-hoc signed; Gatekeeper will warn |
| Windows (x64) — installer | `StickyInc_<version>_x64-setup.exe` | NSIS, unsigned — SmartScreen will warn |
| Windows (x64) — MSI | `StickyInc_<version>_x64_en-US.msi` | for group-policy deployment |
| Linux (Debian/Ubuntu) | `StickyInc_<version>_amd64.deb` | `sudo dpkg -i` |
| Linux (RPM/Fedora) | `StickyInc-<version>-1.x86_64.rpm` | `sudo rpm -i` |
| Linux (portable) | `StickyInc_<version>_amd64.AppImage` | `chmod +x` and run |

> **[Grab the latest release →](https://github.com/Astralchemist/stickyinc/releases/latest)**

First launch pops a one-minute setup wizard: pick an LLM provider, paste a key, confirm the MCP registration. No terminal commands. The MCP server runs on your own Node, so you need [Node.js 22.13+](https://nodejs.org) installed.

---

## Quickstart

Already have an installer running? Open any Claude Desktop or Claude Code session and say:

> *I need to call the dentist Friday afternoon.*

The task appears in your pane before Claude finishes its reply.

### Quick-add without a chat

While the pane is running, press **⌘⇧N** (macOS) or **Ctrl+Shift+N** (Windows/Linux). A centered input appears — type, hit Enter, done. Inline dates work, in your local time: `buy bread due:2026-04-25` (9 am) or `call mum due:2026-04-25T15:30`.

### Reminders

While the pane runs, you get a notification a day before a task is due and again when it's due (StickyInc asks for permission the first time). They follow your system's Do Not Disturb and Focus settings. A task due within a day, or overdue, offers **Snooze 1h** or **tomorrow** (9 am) when you hover it, and the "Due now" pop-out at the screen edge opens the pane when clicked.

---

## MCP tools

| Tool | What it does |
|---|---|
| `add_task` | Add a todo. Optional `due_at`: the user's words (*"Friday 3pm"*, *"tomorrow"*) or ISO 8601. |
| `add_task_natural` | Parse free text ("*call dentist Friday 3pm*"): the configured LLM finds the task and the words that say when. |
| `list_tasks` | Return open tasks; silently appends `Done today (N)` so Claude has state continuity. |
| `list_done` | Return recently completed tasks, optional archive. |
| `sticky_search` | Search every task, open and done, by the words in it or the words it came from; filter by `status` and `since` (*"3 weeks ago"*). Up to 20, best match first, each with when it was added. |
| `complete_task` | Mark a task done. |
| `schedule_event` | Create a dated local task. Calendar sync is deferred to Claude's own connector (see below). |

### Prompts

Three ready-made prompts, for day-one value without writing any: they appear wherever your client lists MCP prompts (in Claude Code, as `/mcp__stickyinc__morning_review` and so on). Each fills itself in with your tasks and ends with a numbered action list.

| Prompt | What it does |
|---|---|
| `morning_review` | Overdue, due today, due this week, and your oldest undated tasks: what matters today, and an action list for it. |
| `overdue` | Each overdue task with when you added it and what you said: do it now, reschedule it, or drop it. |
| `weekly_closeout` | The week's done, added, slipped and due-next tasks, and an action list for next week. |

To have them run by themselves, every weekday morning say, see [Running StickyInc on a schedule](./docs/routines.md): recipes for Claude Desktop, launchd and cron.

### Routines

Save your own prompts as routines: ask Claude something like *"save a routine called waiting on others that asks what I'm waiting on from people, for Fridays at 3pm"*. Each routine appears next to the built-in prompts under its name, and can be exported as JSON to share (`sticky_routine_list` with `format: json`) and imported from someone else's (`sticky_routine_import`). Two examples to start from are in [`routines/`](./routines).

| Tool | What it does |
|---|---|
| `sticky_routine_list` | List your routines, or export them as JSON. |
| `sticky_routine_save` | Add a routine (a name, the prompt, and when it's meant to run), or replace one with the same name. |
| `sticky_routine_delete` | Delete a routine. |
| `sticky_routine_import` | Import routines from JSON; all or nothing. |

### Where a task came from

Rest the pointer on a task in the pane to see where it came from: the words it came from, the app, and when, e.g. *"Remind me to call the dentist Friday afternoon…"* — Added from Claude Code · 2h ago. The tools that add tasks take an optional `context` with an `excerpt` (the user's words, kept to 200 characters) and a `ref` (a file, URL, or ticket), and the server records the app from the MCP handshake. Passive extraction stores the sentence it heard and a pointer to the transcript message. They're kept in `source_client`, `source_ref` and `source_excerpt`.

### Due dates

The server works out due dates, not the model, so the same words at the same moment always give the same date. Claude passes along what you said (*"Friday 3pm"*, *"tomorrow"*, *"in 2 hours"*, *"next week"*) and StickyInc reads it with [chrono](https://github.com/wanasit/chrono), in your time zone.

- A day with no time means 9 am. "Today" after 9 am means the end of today.
- Relative words are read against when they were said: the moment of the tool call, or the message's timestamp for passive extraction.
- Your words are stored in `due_phrase` next to `due_at`, and the task's create event records the moment they were read against, so any date can be traced back to what was said.

`add_task` rejects words it can't read (*"EOD"*, *"the 5th"*) so Claude can rephrase; `add_task_natural` and passive extraction keep the task without a due date.

### Keeping tasks somewhere else

The MCP server writes to `~/.stickyinc/tasks.db` unless `STICKYINC_DB` points elsewhere. The pane only reads the default, so use this for a list you don't want on the strip:

```bash
claude mcp add -s user stickyinc -e STICKYINC_DB=~/work-tasks.db -- npx -y stickyinc
```

---

## LLM providers

`add_task_natural` and the passive extraction daemon work with any of:

| Provider | How it authenticates | Detected via | Default model |
|---|---|---|---|
| **Claude Code** — your Claude Max / Pro subscription, *no API key* | local `claude` CLI OAuth | `claude` on `$PATH` | `haiku` |
| **Codex (ChatGPT)** — your ChatGPT Plus / Pro / Team subscription, *no API key* | local `codex` CLI OAuth | `codex` on `$PATH` | whatever `codex` defaults to |
| **Gemini** — your Google account (Gemini Advanced quota or free tier), *no API key* | local `gemini` CLI OAuth | `gemini` on `$PATH` | whatever `gemini` defaults to |
| **Local (Ollama / LM Studio)** — fully offline, free, no cloud call at all | — | `:11434` or `:1234` responding | first installed model |
| **OpenRouter** — one key, ~200 models, cheapest per token | API key | `OPENROUTER_API_KEY` | `anthropic/claude-haiku-4.5` |
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

Override the model on any env-var or auto-detect path with `STICKYINC_MODEL=…`. Each LLM call gives up after 90 seconds; raise that with `STICKYINC_LLM_TIMEOUT_MS=…` if you run a slow local model.

### A note on subscription-mode tradeoffs

Both `claude-code` and `codex` providers run a subprocess per call (~500ms–1s of overhead) and share the user's subscription rate limits. For interactive quick-add and the once-per-turn passive daemon this is imperceptible; if you end up in a tight extraction loop, configure a direct API provider instead. Subscription routes also mean StickyInc never touches your auth tokens — they stay in whatever state directory the CLI manages (`~/.claude/`, `~/.codex/`).

---

## Passive extraction (opt-in)

A daemon that tails your Claude Code transcripts and auto-surfaces commitments you mention in passing.

Turn it on in the setup wizard's last step (re-open setup any time from the pane's **setup** link). The pane then runs it in the background with your configured LLM, stops it when you quit, and writes its output to `~/.stickyinc/watcher.log`. You can also run it by hand:

```bash
npx -y -p stickyinc stickyinc-watch   # or, from a clone: pnpm watch
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

### Stack pages from your browser

Right-click any page, link or selection → **Stack on StickyInc** → Read, Reply, Review or Decide. The page becomes a task about what you owe it (*Reply to “Q3 budget thread”*) with its address and your selection as where it came from, so due dates, reminders, search and "you clipped this to reply to last Tuesday" all work. Reply is due tomorrow at 9am; the rest have no date. Clips sit in a stack at the top of the pane: hover to fan it out, click a page to open it, tick it when it's done. Chrome and Edge for now; see [extension/README.md](./extension/README.md) to install it and pair it with the app.

### Apple Reminders (macOS)

Turn it on from the pane's gear → Settings → Apple Reminders. Your open tasks then go to a **StickyInc** list in Reminders, which iCloud puts on your iPhone and Watch: updated when a task's text or due time changes, and ticked when you finish it. It's one way for now, so changes made in Reminders stay there. macOS asks once for permission to control Reminders; if you said no, allow StickyInc in System Settings → Privacy & Security → Automation.

### Your dated tasks in any calendar (.ics)

While the pane runs, it keeps `~/.stickyinc/stickyinc.ics` up to date: every open task with a due date is a 30-minute event at its due time, with the words it came from in the notes. Finished tasks drop out. Each event's UID is its task's, so a calendar that refreshes the file updates events instead of adding copies. (Tasks added while the pane is closed appear the next time it opens.)

- **Apple Calendar:** File → New Calendar Subscription…, then paste the file's address: `file:///Users/<you>/.stickyinc/stickyinc.ics`. The pane's gear → Settings → Calendar → **Copy address** gives you yours. Pick an auto-refresh interval and your tasks stay in step.
- **Google Calendar, Outlook and others** can't read a file on your computer, so import it instead (Google: Settings → Import & export). That's a one-time copy; import again to pick up changes.

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

macOS and Windows need only Rust + Node 22.13+. Release builds run through GitHub Actions — see `.github/workflows/build.yml`.

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
  [x] v0.1     MCP server, SQLite, four tools.
  [x] v0.2     Tauri edge-strip pane.
  [x] v0.3     Recently-done + Archive drawer, list_done, CI,
               LLMProvider (Anthropic + OpenRouter + OpenAI-compat),
               add_task_natural.
  [x] v0.4     Passive extraction daemon, fingerprint dedup,
               done-today feedback in list_tasks.
  [x] v0.5     Global ⌘⇧N quick-add window, full icon set,
               one-click setup wizard, tagged release builds
               for macOS / Windows / Linux.
  [x] v0.5.1   Subscription-mode providers (Claude Code, Codex,
               Gemini, Ollama/LM Studio) with zero-key auto-detect.
               Sidebar hidden until setup is done — subtle bulge
               notifications for new tasks, due crossings, and
               incomplete setup.

  [ ] v0.6     ▸ in-app auto-updater (check + download + install
                 signed bundles on launch; users never miss a fix)
               ▸ wizard reworked to detect claude / codex / gemini
                 CLIs and offer zero-key "use my subscription" as
                 the default; API key becomes the fallback, not
                 the front door
               ▸ signed + notarized macOS installer, signed MSI on
                 Windows (see SIGNING.md)
               ▸ UUID task IDs + append-only event log — unlocks
                 multi-device sync, undo, and audit history. Done
                 on desktop regardless of mobile, because the
                 migration is scary later and free now.

  [ ] v0.7     ▸ phone access without an app: desktop pane serves
                 a read-only LAN web view over HTTPS — bookmark
                 it on your phone, no store review, no sync engine
               ▸ per-project tasks (separate DBs per Claude Code
                 workspace), weekly digest, menu-bar quick-add

  [ ] v0.8+    ▸ native mobile (Tauri 2 iOS + Android) — viewer,
                 quickadd, share-sheet, voice capture via Siri /
                 Assistant Shortcuts
               ▸ LAN sync over mDNS + self-signed TLS + QR
                 pairing (LocalSend-style). No relay, no backend.
                 Filesystem sync (iCloud / Dropbox / Syncthing)
                 remains the documented "away from home" path.
```

---

## License

MIT. Do what you want.
