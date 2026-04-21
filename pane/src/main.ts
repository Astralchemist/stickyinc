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

const STRIP_W = 8;
const PANE_W = 320;
const PANE_H_FRAC = 1.0;

const body = document.body;
const tasksEl = document.getElementById("tasks") as HTMLUListElement;
const countEl = document.getElementById("count") as HTMLSpanElement;
const recentSection = document.getElementById("recent-section") as HTMLElement;
const recentEl = document.getElementById("recent") as HTMLUListElement;
const drawerEl = document.getElementById("drawer") as HTMLDetailsElement;
const archiveEl = document.getElementById("archive") as HTMLUListElement;
const archiveCountEl = document.getElementById("archive-count") as HTMLSpanElement;

async function positionWindow(expanded: boolean): Promise<void> {
  const w = getCurrentWindow();
  const mon = await currentMonitor();
  if (!mon) return;
  const scale = mon.scaleFactor;
  const screenW = mon.size.width / scale;
  const screenH = mon.size.height / scale;
  const paneH = Math.round(screenH * PANE_H_FRAC);
  const width = expanded ? PANE_W : STRIP_W;
  await w.setSize(new LogicalSize(width, paneH));
  await w.setPosition(new LogicalPosition(Math.round(screenW - width), 0));
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

async function refresh(): Promise<void> {
  try {
    const [open, recent, archived] = await Promise.all([
      invoke<Task[]>("list_open_tasks"),
      invoke<Task[]>("list_recent_done", { hours: 24 }),
      invoke<Task[]>("list_archived_done", { hours: 24, limit: 100 }),
    ]);

    renderOpen(open);

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
  if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
  if (body.classList.contains("expanded")) return;
  expandTimer = window.setTimeout(async () => {
    await positionWindow(true);
    body.classList.add("expanded");
  }, 120);
}

function collapse(): void {
  if (expandTimer) { clearTimeout(expandTimer); expandTimer = null; }
  if (!body.classList.contains("expanded")) return;
  collapseTimer = window.setTimeout(async () => {
    body.classList.remove("expanded");
    setTimeout(() => positionWindow(false), 220);
  }, 400);
}

async function bootstrap(): Promise<void> {
  await positionWindow(false);

  document.getElementById("strip")?.addEventListener("mouseenter", expand);
  document.getElementById("pane")?.addEventListener("mouseenter", expand);
  document.getElementById("pane")?.addEventListener("mouseleave", collapse);
  document.getElementById("strip")?.addEventListener("mouseleave", (e) => {
    // only collapse if not moving onto pane
    if (!(e.relatedTarget as Element)?.closest?.("#pane")) collapse();
  });

  document.getElementById("setup-link")?.addEventListener("click", () => {
    void invoke("open_wizard");
  });

  await refresh();

  await listen("tasks-changed", () => refresh());

  // Poll fallback every 3s in case watcher hiccups
  setInterval(refresh, 3000);
}

bootstrap();
