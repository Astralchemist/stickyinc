import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize, LogicalPosition } from "@tauri-apps/api/window";
import { currentMonitor } from "@tauri-apps/api/window";
import { check as checkForUpdate, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { openUrl } from "@tauri-apps/plugin-opener";
import { calendarFile } from "./calendar";
import { reminderBody, remindersDue, tomorrowMorning } from "./reminders";

interface Task {
  id: number;
  uuid: string;
  text: string;
  created_at: string;
  completed_at: string | null;
  due_at: string | null;
  source: string;
  source_client: string | null;
  source_ref: string | null;
  source_excerpt: string | null;
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
const REMINDER_POLL_MS = 60_000;
/** Reminder keys already sent (see reminders.ts), kept across restarts. */
const REMINDERS_SENT_KEY = "stickyinc.remindersSent";
/** Due within this long (or overdue): the task's row offers a snooze. */
const SNOOZE_WINDOW_MS = 24 * 3_600_000;
const IS_MAC = navigator.userAgent.includes("Mac");
const TOUR_SEEN_KEY = "stickyinc.tourSeen";
/** The first-run tour: what the pane is and the four things to know. */
const TOUR = [
  "Claude writes here. Mention something you need to do in a Claude chat, like “I need to call the dentist Friday”, and it lands on this list.",
  "Tick a task to finish it. It stays under Recently done for a day.",
  "Rest the pointer on a task to see where it came from: the words it came from, and which app.",
  `Press ${IS_MAC ? "⌘⇧N" : "Ctrl+Shift+N"} to add one yourself. To open this pane, rest the pointer on the right edge of your screen.`,
];

/** Rest on a task this long to see where it came from; passing over doesn't. */
const PROVENANCE_DELAY_MS = 400;

const body = document.body;
const paneEl = document.getElementById("pane") as HTMLDivElement;
const provenanceEl = document.getElementById("provenance") as HTMLDivElement;
const tasksEl = document.getElementById("tasks") as HTMLUListElement;
const stackEl = document.getElementById("stack") as HTMLElement;
const countEl = document.getElementById("count") as HTMLSpanElement;
const recentSection = document.getElementById("recent-section") as HTMLElement;
const recentEl = document.getElementById("recent") as HTMLUListElement;
const drawerEl = document.getElementById("drawer") as HTMLDetailsElement;
const archiveEl = document.getElementById("archive") as HTMLUListElement;
const archiveCountEl = document.getElementById("archive-count") as HTMLSpanElement;
const bulgeEl = document.getElementById("bulge") as HTMLDivElement;
const bulgeTextEl = document.getElementById("bulge-text") as HTMLSpanElement;
const bulgeIconEl = document.getElementById("bulge-icon") as HTMLSpanElement;

// null until bootstrap's first setMode, so that call always applies: the
// window starts 8px wide at the top-left (tauri.conf.json) with no class.
let currentMode: Mode | null = null;
let setupComplete = false;
let lastBulgeAt = 0;
let bulgeTimer: number | null = null;
let knownTaskIds: Set<number> | null = null;
let lastDueCheck = Date.now();
let seededSetupBulge = false;
let provenanceTimer: number | null = null;
/** Whether the OS lets us notify; asked once, when the first reminder is due. */
let notificationsAllowed: boolean | null = null;
/** What the stack was last drawn from; see renderStack. */
let stackKey = "";
/** What the calendar file was last written from; unchanged tasks, no write. */
let calendarKey = "";
/** Index into TOUR while the tour is showing. */
let tourStep: number | null = null;
/** The task whose card is showing or about to show; refresh() carries it over. */
let provenanceTaskId: number | null = null;

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
  const growing = currentMode === null || modeWidth(mode) > modeWidth(currentMode);
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

/** SQLite's datetime('now') (UTC, no zone) as "2h ago", "yesterday", "Sep 20". */
function formatAgo(sqliteUtc: string): string {
  const then = new Date(sqliteUtc.replace(" ", "T") + "Z").getTime();
  const mins = Math.round((Date.now() - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return days === 1 ? "yesterday" : `${days} days ago`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** How a task got here, in words: "Overheard in Claude Code · 2h ago". */
function provenanceLine(task: Task): string {
  const app = task.source_client;
  const how =
    isClip(task) ? `Clipped in ${app ?? "your browser"} from ${new URL(task.source_ref!).hostname.replace(/^www\./, "")}`
    : task.source === "passive-extract" ? `Overheard in ${app ?? "Claude Code"}`
    : task.source === "calendar" ? (app ? `Scheduled from ${app}` : "Scheduled by Claude")
    : app ? `Added from ${app}` : "Added by Claude";
  return `${how} · ${formatAgo(task.created_at)}`;
}

function showProvenance(li: HTMLElement, task: Task): void {
  provenanceTaskId = task.id;
  provenanceEl.replaceChildren();
  if (task.source_excerpt) {
    const quote = document.createElement("p");
    quote.className = "excerpt";
    quote.textContent = `“${task.source_excerpt}”`;
    provenanceEl.appendChild(quote);
  }
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = provenanceLine(task);
  provenanceEl.appendChild(meta);
  provenanceEl.hidden = false;

  // Below the task if it fits in the window (it may hang past the bottom of
  // a short pane), else above; #pane is the positioning box.
  const pane = paneEl.getBoundingClientRect();
  const row = li.getBoundingClientRect();
  const h = provenanceEl.offsetHeight;
  const below = row.bottom - pane.top + 4;
  const top = pane.top + below + h <= window.innerHeight - 8 ? below : row.top - pane.top - h - 4;
  provenanceEl.style.top = `${Math.max(8, top)}px`;
}

function hideProvenance(): void {
  if (provenanceTimer) clearTimeout(provenanceTimer);
  provenanceTimer = null;
  provenanceTaskId = null;
  provenanceEl.hidden = true;
}

function scheduleProvenance(li: HTMLElement, task: Task): void {
  // Already showing it (a re-rendered row under a resting pointer): follow
  // the new row rather than blinking out for another delay.
  if (provenanceTaskId === task.id && !provenanceEl.hidden) return showProvenance(li, task);
  hideProvenance();
  provenanceTaskId = task.id;
  provenanceTimer = window.setTimeout(() => showProvenance(li, task), PROVENANCE_DELAY_MS);
}

/** Rest on a task to see where it came from. Quick-adds are the user's own. */
function attachProvenance(li: HTMLElement, task: Task): void {
  if (task.source === "quickadd") return;
  li.addEventListener("mouseenter", () => scheduleProvenance(li, task));
  li.addEventListener("mouseleave", hideProvenance);
}

/** A task clipped from a web page by the browser extension. */
function isClip(t: Task): boolean {
  return t.source.startsWith("clip:") && Boolean(t.source_ref);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * The site's own favicon (asked of the site itself, so no third party
 * learns what you clip), or the site's first letter if it has none.
 */
function favicon(url: string): HTMLElement {
  const { origin, hostname } = new URL(url);
  const img = el("img", "favicon");
  img.alt = "";
  img.src = `${origin}/favicon.ico`;
  img.addEventListener(
    "error",
    () => img.replaceWith(el("span", "favicon letter", hostname.replace(/^www\./, "").charAt(0).toUpperCase() || "?")),
    { once: true },
  );
  return img;
}

const INTENT_LABELS: Record<string, string> = { read: "Read", reply: "Reply", review: "Review", decide: "Decide" };

/** Tick a task off: the row strikes through, then the list refreshes. */
async function completeFrom(li: HTMLElement, task: Task): Promise<void> {
  hideProvenance();
  li.classList.add("done");
  try {
    await invoke("complete_task", { id: task.id });
    setTimeout(() => refresh(), 450);
  } catch (err) {
    li.classList.remove("done");
    console.error(err);
  }
}

/** One clipped page as a tile: favicon, intent, title, due. Click to open the page. */
function stackTile(task: Task, i: number): HTMLElement {
  const li = el("li", "task tile");
  li.dataset.id = String(task.id);
  li.style.setProperty("--i", String(i));
  const intent = task.source.slice("clip:".length);
  const text = el("div", "tile-body");
  text.append(
    el("span", `intent intent-${intent}`, INTENT_LABELS[intent] ?? intent),
    el("span", "tile-title", task.text.match(/“(.*)”$/)?.[1] ?? task.text),
  );
  if (task.due_at) text.append(el("span", "due" + (isOverdue(task.due_at) ? " overdue" : ""), formatDue(task.due_at)));
  const check = el("div", "check");
  check.title = "Done";
  check.addEventListener("click", (e) => {
    e.stopPropagation(); // the tile's own click opens the page
    void completeFrom(li, task);
  });
  li.append(favicon(task.source_ref!), text, check);
  li.addEventListener("click", () => void openUrl(task.source_ref!));
  attachProvenance(li, task);
  return li;
}

/**
 * Pages clipped from the browser, Dock-style: a pile of favicons that fans
 * out into tiles on hover, over the tasks below so nothing shifts.
 */
function renderStack(clips: Task[]): void {
  // The pane refreshes every 3 s; redrawing an unchanged stack would replay
  // its fan-out under a hovering pointer. The day and overdue state are in
  // the key because they change how due times read.
  const key = JSON.stringify([
    new Date().toDateString(),
    clips.map((t) => [t.id, t.text, t.due_at, t.source_ref, t.due_at !== null && isOverdue(t.due_at)]),
  ]);
  if (key === stackKey) return;
  stackKey = key;
  stackEl.hidden = clips.length === 0;
  stackEl.replaceChildren();
  if (clips.length === 0) return;
  const pile = el("div", "stack-pile");
  clips.slice(0, 4).forEach((t, i) => {
    const icon = favicon(t.source_ref!);
    icon.style.setProperty("--i", String(i));
    pile.append(icon);
  });
  const head = el("div", "stack-head");
  head.append(pile, el("span", "stack-label", `Stack · ${clips.length}`));
  const tiles = el("ul", "stack-tiles");
  clips.forEach((t, i) => tiles.append(stackTile(t, i)));
  stackEl.append(head, tiles);
}

function renderOpen(tasks: Task[]): void {
  tasksEl.innerHTML = "";
  countEl.textContent = `${tasks.length} open`;

  const hasDue = tasks.some((t) => t.due_at && isOverdue(t.due_at));
  body.classList.toggle("has-due", hasDue);

  renderStack(tasks.filter(isClip));
  if (tasks.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Nothing sticky yet.";
    tasksEl.appendChild(empty);
    return;
  }

  for (const task of tasks.filter((t) => !isClip(t))) {
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
      if (Date.parse(task.due_at) - Date.now() < SNOOZE_WINDOW_MS) due.append(snoozeControls(task));
      text.appendChild(due);
    }

    li.appendChild(check);
    li.appendChild(text);
    attachProvenance(li, task);

    li.addEventListener("click", () => void completeFrom(li, task));

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
    attachProvenance(li, task);
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
      // Clickable: opens the pane, where the task's row offers a snooze.
      void showBulge(`Due now: ${clip(t.text)}`, { icon: "!", onClick: () => void setMode("expanded") });
      break; // one bulge per tick even if multiple fired together
    }
  }
  lastDueCheck = now;
}

function loadRemindersSent(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(REMINDERS_SENT_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

async function canNotify(): Promise<boolean> {
  if (notificationsAllowed === null) {
    notificationsAllowed =
      (await isPermissionGranted().catch(() => false)) ||
      (await requestPermission().catch(() => "denied")) === "granted";
  }
  return notificationsAllowed;
}

/**
 * Native notifications a day before each dated task is due and when it's
 * due, checked every minute. The OS decides whether they show (Do Not
 * Disturb, Focus, notification settings); the pane only sends them.
 */
async function checkReminders(): Promise<void> {
  if (!setupComplete) return;
  const open = await invoke<Task[]>("list_open_tasks").catch(() => null);
  if (!open) return;
  const sent = loadRemindersSent();
  // Forget finished tasks' reminders so the list doesn't grow forever.
  const uuids = new Set(open.map((t) => t.uuid));
  for (const key of sent) if (!uuids.has(key.split("|")[0])) sent.delete(key);

  const due = remindersDue(open, Date.now(), sent);
  if (due.length > 0 && (await canNotify())) {
    for (const r of due) sendNotification({ title: r.task.text, body: reminderBody(r) });
  }
  // Marked sent even if notifications are off, so turning them on later
  // doesn't bring a burst of old ones.
  for (const r of due) sent.add(r.key);
  try {
    localStorage.setItem(REMINDERS_SENT_KEY, JSON.stringify([...sent]));
  } catch {
    /* may repeat after a restart; harmless */
  }
}

/** "Snooze 1h · tomorrow" for a task that's due soon or overdue; shown on hover. */
function snoozeControls(task: Task): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "snooze";
  wrap.append("Snooze");
  const options: [string, () => Date][] = [
    ["1h", () => new Date(Date.now() + 3_600_000)],
    ["tomorrow", () => tomorrowMorning()],
  ];
  for (const [label, until] of options) {
    const button = document.createElement("button");
    button.textContent = label;
    button.addEventListener("click", async (e) => {
      e.stopPropagation(); // the row's own click completes the task
      try {
        await invoke("snooze_task", { id: task.id, until: until().toISOString() });
        await refresh();
      } catch (err) {
        console.error("snooze failed", err);
      }
    });
    wrap.append(button);
  }
  return wrap;
}

/**
 * Keep ~/.stickyinc/stickyinc.ics in step with the open dated tasks. Only
 * when they change: the file's timestamps would differ on every refresh.
 */
async function writeCalendar(open: Task[]): Promise<void> {
  const dated = open.filter((t) => t.due_at);
  const key = JSON.stringify(dated.map((t) => [t.uuid, t.text, t.due_at, t.source_client, t.source_excerpt]));
  if (key === calendarKey) return;
  try {
    await invoke("write_calendar", { ics: calendarFile(dated) });
    calendarKey = key;
  } catch (err) {
    console.error("calendar export failed", err);
  }
}

async function refresh(): Promise<void> {
  try {
    const [open, recent, archived] = await Promise.all([
      invoke<Task[]>("list_open_tasks"),
      invoke<Task[]>("list_recent_done", { hours: 24 }),
      invoke<Task[]>("list_archived_done", { hours: 24, limit: 100 }),
    ]);

    // Rendering replaces the row under a resting pointer, and the new row
    // never gets a mouseenter, so note the card and move it across after.
    const carried = provenanceTaskId;
    const wasShown = !provenanceEl.hidden;
    hideProvenance();

    renderOpen(open);
    detectBulges(open);
    void writeCalendar(open);

    recentSection.hidden = recent.length === 0;
    renderDoneList(recentEl, recent);

    drawerEl.hidden = archived.length === 0;
    archiveCountEl.textContent = String(archived.length);
    renderDoneList(archiveEl, archived);

    const task = [...open, ...recent, ...archived].find((t) => t.id === carried);
    const li = task && document.querySelector<HTMLElement>(`li.task[data-id="${task.id}"]`);
    if (task && li) {
      if (wasShown) showProvenance(li, task);
      else scheduleProvenance(li, task);
    }
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

function tourSeen(): boolean {
  try {
    return localStorage.getItem(TOUR_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

function renderTour(): void {
  const el = document.getElementById("tour") as HTMLElement;
  el.hidden = tourStep === null;
  if (tourStep === null) return;
  document.getElementById("tour-text")!.textContent = TOUR[tourStep];
  document.getElementById("tour-count")!.textContent = `${tourStep + 1} of ${TOUR.length}`;
  document.getElementById("tour-next")!.textContent = tourStep === TOUR.length - 1 ? "Got it" : "Next";
}

function startTour(): void {
  tourStep = 0;
  renderTour();
}

function endTour(): void {
  tourStep = null;
  try {
    localStorage.setItem(TOUR_SEEN_KEY, "1");
  } catch {
    /* shows again next launch; harmless */
  }
  renderTour();
}

function showSetupOrSettings(): void {
  (document.getElementById("setup-link") as HTMLElement).hidden = setupComplete;
  (document.getElementById("settings-link") as HTMLElement).hidden = !setupComplete;
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
  // Close on leaving the window, not the pane: the pane is only as tall as
  // its tasks, and the edge may be hovered well below it. Open, the window
  // is the pane's full-height column, so moving up to the pane keeps it open.
  document.documentElement.addEventListener("mouseleave", collapse);
  tasksEl.addEventListener("scroll", hideProvenance);

  // "setup" until the wizard is finished, then a gear that opens settings.
  showSetupOrSettings();

  document.getElementById("tour-next")?.addEventListener("click", () => {
    if (tourStep === null) return;
    if (tourStep === TOUR.length - 1) endTour();
    else {
      tourStep += 1;
      renderTour();
    }
  });
  document.getElementById("tour-skip")?.addEventListener("click", endTour);
  if (setupComplete && !tourSeen()) startTour();
  for (const id of ["setup-link", "settings-link"]) {
    document.getElementById(id)?.addEventListener("click", () => {
      void invoke("open_wizard");
    });
  }

  await refresh();

  await listen("tasks-changed", () => refresh());
  await listen("show-tour", startTour); // from Settings
  await listen("setup-complete", async () => {
    setupComplete = true;
    showSetupOrSettings();
    if (!tourSeen()) startTour();
    // User just finished the wizard — flip into strip mode and stop hiding.
    if (currentMode === "hidden") {
      await setMode("strip");
    }
  });

  setInterval(refresh, 3000);
  setInterval(() => { void checkDueCrossings(); }, DUE_POLL_MS);
  void checkReminders();
  setInterval(() => { void checkReminders(); }, REMINDER_POLL_MS);
  // Apple Reminders, if turned on in Settings (a no-op otherwise).
  const syncReminders = () => invoke("sync_reminders").catch((err) => console.error("Reminders sync:", err));
  void syncReminders();
  setInterval(() => { void syncReminders(); }, REMINDER_POLL_MS);

  // Background update check — 15s after launch so it doesn't fight the
  // setup bulge for screen real estate. Silent on network errors / 404
  // (e.g. running a dev build with no signed release yet).
  setTimeout(() => { void runUpdateCheck(); }, 15_000);
}

async function runUpdateCheck(): Promise<void> {
  let update: Update | null = null;
  try {
    update = await checkForUpdate();
  } catch (err) {
    // 404 from GitHub means we just haven't published a signed `latest.json`
    // for the user's current track yet (common on dev builds and for the
    // window between a tag push and the build artifacts uploading). Silent.
    // Anything else — DNS, signature mismatch, malformed manifest — is worth
    // a console warning so it's debuggable from devtools, but we still keep
    // the user-facing UI quiet so transient network issues don't fight the
    // bulge for screen real estate.
    const message = err instanceof Error ? err.message : String(err);
    if (!/\b404\b/.test(message)) {
      console.warn("update check failed:", message);
    }
    return;
  }
  if (!update?.available) return;

  const version = update.version;
  void showBulge(`Update to v${version} →`, {
    icon: "↑",
    onClick: () => void installUpdate(update!),
  });
}

async function installUpdate(update: Update): Promise<void> {
  try {
    await update.downloadAndInstall();
    // Give the install a moment, then restart. downloadAndInstall is
    // supposed to exit the process on Windows MSI; on macOS/Linux we
    // relaunch to pick up the new binary.
    await relaunch();
  } catch (err) {
    console.error("update failed", err);
    void showBulge(`Update failed — try manually`, {
      icon: "!",
      onClick: () => {
        void invoke("open_wizard"); // no dedicated "about" yet; wizard closes cleanly
      },
    });
  }
}

bootstrap();
