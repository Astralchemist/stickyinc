/**
 * User-defined routines: a named prompt plus a hint of when to run it. Each
 * is also offered as an MCP prompt under its name, so it sits in the prompt
 * menu next to the built-in ones and runs on a schedule the same way
 * (`claude -p "/mcp__stickyinc__<name>"`, docs/routines.md). Pure: parsing,
 * naming and the prompt text; storage is in db.ts.
 */

/** The canned prompts' names, which a routine can't take. */
export const BUILT_IN_PROMPTS = ["morning_review", "overdue", "weekly_closeout"];

export const PROMPT_MAX = 4000;
const SCHEDULE_MAX = 100;

export interface RoutineInput {
  name: string;
  prompt: string;
  schedule?: string | null;
}

/**
 * A routine's name as a prompt name: lowercase letters, digits and
 * underscores ("Waiting on others" → "waiting_on_others"), so it works as
 * a slash command. Null if nothing usable is left.
 */
export function routineName(name: string): string | null {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40)
    .replace(/_+$/, "");
  return /^[a-z0-9]/.test(slug) ? slug : null;
}

/** A routine made safe to store, or the reason it can't be. */
export function checkRoutine(input: unknown): { routine: RoutineInput } | { error: string } {
  if (!input || typeof input !== "object") return { error: "a routine is an object with a name and a prompt" };
  const { name, prompt, schedule } = input as Record<string, unknown>;
  if (typeof name !== "string" || !routineName(name)) return { error: "it needs a name with letters or digits in it" };
  const slug = routineName(name)!;
  if (BUILT_IN_PROMPTS.includes(slug)) return { error: `"${slug}" is a built-in prompt; pick another name` };
  if (typeof prompt !== "string" || !prompt.trim()) return { error: `"${slug}" needs a prompt` };
  if (prompt.length > PROMPT_MAX) return { error: `"${slug}": the prompt is over ${PROMPT_MAX} characters` };
  if (schedule != null && (typeof schedule !== "string" || schedule.length > SCHEDULE_MAX)) {
    return { error: `"${slug}": the schedule should be a short phrase like "weekdays at 8:30"` };
  }
  return { routine: { name: slug, prompt: prompt.trim(), schedule: schedule ? String(schedule).trim() : null } };
}

/**
 * Routines from JSON: one routine, or an array of them, in the shape
 * export writes. All or nothing: any bad entry and none are imported.
 */
export function parseRoutines(json: string): { routines: RoutineInput[] } | { error: string } {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (e) {
    return { error: `that isn't JSON (${e instanceof Error ? e.message : e})` };
  }
  const items = Array.isArray(data) ? data : [data];
  if (items.length === 0) return { error: "there are no routines in it" };
  const routines: RoutineInput[] = [];
  for (const [i, item] of items.entries()) {
    const checked = checkRoutine(item);
    if ("error" in checked) return { error: items.length > 1 ? `routine ${i + 1}: ${checked.error}` : checked.error };
    routines.push(checked.routine);
  }
  const names = routines.map((r) => r.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) return { error: `"${dup}" appears twice` };
  return { routines };
}

/** The JSON export writes and import reads. */
export function exportRoutines(routines: RoutineInput[]): string {
  return JSON.stringify(
    routines.map(({ name, prompt, schedule }) => ({ name, prompt, schedule: schedule ?? null })),
    null,
    2
  );
}

/** What a routine sends when it's run as a prompt. */
export function routinePromptText(r: RoutineInput): string {
  return `${r.prompt}\n\n(This is my StickyInc routine "${r.name}". Look up what it needs with sticky_search.)`;
}
