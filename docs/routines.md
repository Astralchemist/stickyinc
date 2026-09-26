# Running StickyInc on a schedule

StickyInc doesn't run anything on a timer. It gives you prompts: the built-in `morning_review`, `overdue` and `weekly_closeout`, plus any [routines](../README.md#routines) you've saved. Something you already have runs them: Claude Desktop, launchd on a Mac, or cron on Linux.

Your tasks live in a file on your computer (`~/.stickyinc/tasks.db`), so the run has to happen on that computer too.

## The command

Every recipe below runs one of these:

```bash
# A built-in prompt. Your tasks are already in it, so Claude needs no tools.
claude -p "/mcp__stickyinc__morning_review"

# One of your routines. Routines look things up, so allow StickyInc's search.
claude -p "/mcp__stickyinc__waiting_on_others" --allowedTools "mcp__stickyinc__sticky_search"
```

It prints the review and exits. Try it in a terminal first. You need [Claude Code](https://code.claude.com) signed in, and StickyInc added to it (`claude mcp add -s user stickyinc -- npx -y stickyinc`).

A run like this can't change your tasks unless you allow it. It only reads. To let a routine tick things off, add `mcp__stickyinc__complete_task` to `--allowedTools`, but think twice: nobody's watching when it runs.

## Claude Desktop (Mac or Windows)

Claude Desktop can run a task on your computer on a schedule, with your MCP servers. It runs while the app is open and the computer is awake. If the computer was asleep, it runs once when it wakes.

1. Open the **Code** tab, click **Routines** in the sidebar, then **New routine** → **Local**.
2. **Name:** `stickyinc-morning-review`.
3. **Instructions:**
   > Run my StickyInc morning review. Use StickyInc's sticky_search to get my open tasks. Tell me what's overdue, what's due today and this week, and which undated tasks have been sitting longest. Say what matters most today, and end with an action list of at most 5 steps, each with its task number.
4. Pick a folder (any will do; the review doesn't touch files) and a **Schedule**: **Weekdays** at 8:30.
5. Save, then click **Run now** once. When Claude asks to use StickyInc's tools, choose **Always allow**, so later runs don't stop to ask.

Each run shows up under **Scheduled** in the sidebar, and Desktop notifies you when it fires.

## macOS: launchd

launchd runs jobs on a Mac even when no app is open. This one writes the review to `~/.stickyinc/routines/morning-<date>.md` on weekdays at 8:30 and shows a notification.

1. Save this as `~/Library/LaunchAgents/com.stickyinc.morning-review.plist`:

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
     <key>Label</key>
     <string>com.stickyinc.morning-review</string>
     <key>ProgramArguments</key>
     <array>
       <string>/bin/zsh</string>
       <string>-lc</string>
       <string>mkdir -p ~/.stickyinc/routines &amp;&amp; claude -p "/mcp__stickyinc__morning_review" &lt; /dev/null &gt; ~/.stickyinc/routines/morning-$(date +%F).md 2&gt;&amp;1 &amp;&amp; osascript -e 'display notification "Your morning review is ready" with title "StickyInc"'</string>
     </array>
     <key>StartCalendarInterval</key>
     <array>
       <dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>8</integer><key>Minute</key><integer>30</integer></dict>
       <dict><key>Weekday</key><integer>2</integer><key>Hour</key><integer>8</integer><key>Minute</key><integer>30</integer></dict>
       <dict><key>Weekday</key><integer>3</integer><key>Hour</key><integer>8</integer><key>Minute</key><integer>30</integer></dict>
       <dict><key>Weekday</key><integer>4</integer><key>Hour</key><integer>8</integer><key>Minute</key><integer>30</integer></dict>
       <dict><key>Weekday</key><integer>5</integer><key>Hour</key><integer>8</integer><key>Minute</key><integer>30</integer></dict>
     </array>
   </dict>
   </plist>
   ```

   `zsh -lc` runs it as a login shell, so `claude` and `node` are found wherever you installed them (Homebrew included).

2. Turn it on, and run it once now to check it works:

   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.stickyinc.morning-review.plist
   launchctl kickstart gui/$(id -u)/com.stickyinc.morning-review
   open ~/.stickyinc/routines/morning-$(date +%F).md
   ```

3. To turn it off: `launchctl bootout gui/$(id -u)/com.stickyinc.morning-review`.

For a routine instead of the morning review, swap the `claude -p …` part for the routine's command from [The command](#the-command). To change the time, edit the `Hour` and `Minute` values, then run `bootout` and `bootstrap` again.

If the file says Claude Code isn't signed in, give the job a long-lived token: run `claude setup-token`, then put `export CLAUDE_CODE_OAUTH_TOKEN=<token> && ` at the start of the command string.

## Linux: cron

```bash
claude setup-token   # once: prints a long-lived token for jobs that run without you
crontab -e
```

Add these lines, with your token, and with `PATH` including the folders `which claude` and `which node` print:

```crontab
CLAUDE_CODE_OAUTH_TOKEN=<your token>
PATH=/usr/local/bin:/usr/bin:/bin:/home/you/.local/bin
30 8 * * 1-5  mkdir -p ~/.stickyinc/routines && claude -p "/mcp__stickyinc__morning_review" < /dev/null > ~/.stickyinc/routines/morning-$(date +\%F).md 2>&1
0 16 * * 5    claude -p "/mcp__stickyinc__weekly_closeout" < /dev/null > ~/.stickyinc/routines/week-$(date +\%F).md 2>&1
```

In a crontab, `%` has to be written `\%`.

## Why not Claude's cloud routines?

`/schedule` routines run on Anthropic's servers. They can't reach a file on your computer, so they can't see your StickyInc tasks. Use one of the options above.
