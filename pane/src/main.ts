import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize, LogicalPosition } from "@tauri-apps/api/window";
import { currentMonitor } from "@tauri-apps/api/window";

interface Task {
  id: number;
  text: string;
  created_at: string;
  completed_at: string | null;
  due_at: string | null;
  source: string;
}

type Mode = "hidden" | "strip" | "bulge" | "expanded";

const HIDDEN_W = 1;
const STRIP_W = 8;
const BULGE_W = 240;
const PANE_W = 320;
const PANE_H_FRAC = 1.0;

const BULGE_HOLD_MS = 3500;
const BULGE_COOLDOWN_MS = 30_000;
const DUE_POLL_MS = 30_000;

const body = document.body;
const tasksEl = document.getElementById("tasks") as HTMLUListElement;
const countEl = document.getElementById("count") as HTMLSpanElement;
const recentSection = document.getElementById("recent-section") as HTMLElement;
const recentEl = document.getElementById("recent") as HTMLUListElement;
const drawerEl = document.getElementById("drawer") as HTMLDetailsElement;
const archiveEl = document.getElementById("archive") as HTMLUListElement;
const archiveCountEl = document.getElementById("archive-count") as HTMLSpanElement;
const bulgeEl = document.getElementById("bulge") as HTMLDivElement;
const bulgeTextEl = document.getElementById("bulge-text") as HTMLSpanElement;
const bulgeIconEl = document.getElementById("bulge-icon") as HTMLSpanElement;

let currentMode: Mode = "strip";
let setupComplete = false;
let lastBulgeAt = 0;
let bulgeTimer: number | null = null;
let knownTaskIds: Set<number> | null = null;
let lastDueCheck = Date.now();
let seededSetupBulge = false;

async function positionWindow(width: number): Promise<void> {
  const w = getCurrentWindow();
  const mon = await currentMonitor();
  if (!mon) return;
  const scale = mon.scaleFactor;
  const screenW = mon.size.width / scale;
  const screenH = mon.size.height / scale;
  const paneH = Math.round(screenH * PANE_H_FRAC);
  await w.setSize(new LogicalSize(width, paneH));
  await w.setPosition(new LogicalPosition(Math.round(screenW - width), 0));
}

function modeWidth(mode: Mode): number {
  switch (mode) {
    case "hidden": return HIDDEN_W;
    case "strip":  return STRIP_W;
    case "bulge":  return BULGE_W;
    case "expanded": return PANE_W;
  }
}

async function setMode(mode: Mode): Promise<void> {
  if (mode === currentMode) return;
  // Grow the window BEFORE the class swap so content has room; shrink AFTER
  // the class swap so the retract animation plays in-frame.
  const growing = modeWidth(mode) > modeWidth(currentMode);
  if (growing) {
    await positionWindow(modeWidth(mode));
    body.className = mode;
  } else {
    body.className = mode;
    // CSS transition is ~260ms; resize after it completes.
    setTimeout(() => {
      void positionWindow(modeWidth(mode));
    }, 260);
  }
  currentMode = mode;
}

/** Base mode when no bulge / hover is active — strip if set up, else hidden. */
function restingMode(): Mode {
  return setupComplete ? "strip" : "hidden";
}

function isOverdue(dueAt: string): boolean {
  return new Date(dueAt).getTime() < Date.now();
}

function formatDue(dueAt: string): string {
  const d = new Date(dueAt);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const opts: Intl.DateTimeFormatOptions = sameDay
    ? { hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  return d.toLocaleString(undefined, opts);
}

function renderOpen(tasks: Task[]): void {
  tasksEl.innerHTML = "";
  countEl.textContent = `${tasks.length} open`;

  const hasDue = tasks.some((t) => t.due_at && isOverdue(t.due_at));
  body.classList.toggle("has-due", hasDue);

  if (tasks.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Nothing sticky yet.";
    tasksEl.appendChild(empty);
    return;
  }

  for (const task of tasks) {
    const li = document.createElement("li");
    li.className = "task";
    li.dataset.id = String(task.id);

    const check = document.createElement("div");
    check.className = "check";

    const text = document.createElement("div");
    text.className = "text";
    text.textContent = task.text;

    if (task.due_at) {
      const due = document.createElement("span");
      due.className = "due" + (isOverdue(task.due_at) ? " overdue" : "");
      due.textContent = formatDue(task.due_at);
      text.appendChild(due);
    }

    li.appendChild(check);
    li.appendChild(text);

    li.addEventListener("click", async () => {
      li.classList.add("done");
      try {
        await invoke("complete_task", { id: task.id });
        setTimeout(() => refresh(), 450);
      } catch (err) {
        li.classList.remove("done");
        console.error(err);
      }
    });

    tasksEl.appendChild(li);
  }
}

function renderDoneList(target: HTMLUListElement, tasks: Task[]): void {
  target.innerHTML = "";
  for (const task of tasks) {
    const li = document.createElement("li");
    li.className = "task";
    li.dataset.id = String(task.id);

    const check = document.createElement("div");
    check.className = "check";

    const text = document.createElement("div");
    text.className = "text";
    text.textContent = task.text;

    li.appendChild(check);
    li.appendChild(text);
    target.appendChild(li);
  }
}

/** Truncate for the bulge pill — small space. */
function clip(s: string, n = 38): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

async function showBulge(
  text: string,
  opts: { icon?: string; onClick?: () => void } = {},
): Promise<void> {
  const now = Date.now();
  // Don't interrupt a hovered user.
  if (currentMode === "expanded") return;
  if (now - lastBulgeAt < BULGE_COOLDOWN_MS) return;
  lastBulgeAt = now;

  bulgeTextEl.textContent = text;
  bulgeIconEl.textContent = opts.icon ?? "•";
  bulgeEl.classList.toggle("clickable", Boolean(opts.onClick));
  bulgeEl.onclick = opts.onClick ?? null;

  await setMode("bulge");
  if (bulgeTimer) clearTimeout(bulgeTimer);
  bulgeTimer = window.setTimeout(async () => {
    await setMode(restingMode());
  }, BULGE_HOLD_MS);
}

/**
 * Detect the three notification triggers by diffing successive refreshes:
 *   - a new task appeared (source ≠ quickadd → Claude put it there)
 *   - a task's due_at crossed "now" since the last check
 *
 * First refresh seeds knownTaskIds without bulging, so we don't flash the
 * user for every task the app already knew about on launch.
 */
function detectBulges(tasks: Task[]): void {
  if (!setupComplete) return;

  if (knownTaskIds === null) {
    knownTaskIds = new Set(tasks.map((t) => t.id));
    return;
  }

  const currentIds = new Set(tasks.map((t) => t.id));
  const fresh = tasks.filter((t) => !knownTaskIds!.has(t.id));
  knownTaskIds = currentIds;

  // Only surface tasks that the user didn't type themselves via quick-add.
  const notable = fresh.find((t) => t.source !== "quickadd");
  if (notable) {
    const verb = notable.source === "passive-extract" ? "overheard" : "added";
    void showBulge(`Claude ${verb}: ${clip(notable.text)}`, { icon: "+" });
  }
}

async function checkDueCrossings(): Promise<void> {
  if (!setupComplete) return;
  const tasks = await invoke<Task[]>("list_open_tasks").catch(() => null);
  if (!tasks) return;
  const now = Date.now();
  for (const t of tasks) {
    if (!t.due_at) continue;
    const due = new Date(t.due_at).getTime();
    if (due > lastDueCheck && due <= now) {
      void showBulge(`Due now: ${clip(t.text)}`, { icon: "!" });
      break; // one bulge per tick even if multiple fired together
    }
  }
  lastDueCheck = now;
}

async function refresh(): Promise<void> {
  try {
    const [open, recent, archived] = await Promise.all([
      invoke<Task[]>("list_open_tasks"),
      invoke<Task[]>("list_recent_done", { hours: 24 }),
      invoke<Task[]>("list_archived_done", { hours: 24, limit: 100 }),
    ]);

    renderOpen(open);
    detectBulges(open);

    recentSection.hidden = recent.length === 0;
    renderDoneList(recentEl, recent);

    drawerEl.hidden = archived.length === 0;
    archiveCountEl.textContent = String(archived.length);
    renderDoneList(archiveEl, archived);
  } catch (err) {
    console.error("refresh failed", err);
  }
}

let expandTimer: number | null = null;
let collapseTimer: number | null = null;

function expand(): void {
  if (!setupComplete) return; // no hover-to-expand if the pane is hidden
  if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
  if (currentMode === "expanded") return;
  expandTimer = window.setTimeout(async () => {
    if (bulgeTimer) { clearTimeout(bulgeTimer); bulgeTimer = null; }
    await setMode("expanded");
  }, 120);
}

function collapse(): void {
  if (expandTimer) { clearTimeout(expandTimer); expandTimer = null; }
  if (currentMode !== "expanded") return;
  collapseTimer = window.setTimeout(async () => {
    await setMode(restingMode());
  }, 400);
}

async function bootstrap(): Promise<void> {
  setupComplete = await invoke<boolean>("get_setup_complete").catch(() => false);
  await setMode(restingMode());

  // If setup is incomplete, nudge the user back to the wizard once per
  // launch. The first launch also auto-opens the wizard from Rust, so this
  // is for cases where they closed it without finishing.
  if (!setupComplete && !seededSetupBulge) {
    seededSetupBulge = true;
    setTimeout(() => {
      void showBulge("Finish StickyInc setup →", {
        icon: "↗",
        onClick: () => void invoke("open_wizard"),
      });
    }, 8_000);
  }

  document.getElementById("strip")?.addEventListener("mouseenter", expand);
  document.getElementById("pane")?.addEventListener("mouseenter", expand);
  document.getElementById("pane")?.addEventListener("mouseleave", collapse);
  document.getElementById("strip")?.addEventListener("mouseleave", (e) => {
    if (!(e.relatedTarget as Element)?.closest?.("#pane")) collapse();
  });

  document.getElementById("setup-link")?.addEventListener("click", () => {
    void invoke("open_wizard");
  });

  await refresh();

  await listen("tasks-changed", () => refresh());
  await listen("setup-complete", async () => {
    setupComplete = true;
    // User just finished the wizard — flip into strip mode and stop hiding.
    if (currentMode === "hidden") {
      await setMode("strip");
    }
  });

  setInterval(refresh, 3000);
  setInterval(() => { void checkDueCrossings(); }, DUE_POLL_MS);
}

bootstrap();
