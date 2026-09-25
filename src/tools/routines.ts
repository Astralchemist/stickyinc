import { z } from "zod";
import { deleteRoutine, listRoutines, saveRoutine } from "../db.js";
import { checkRoutine, exportRoutines, parseRoutines, PROMPT_MAX, routineName } from "../routines.js";

const text = (t: string, isError = false) => ({
  content: [{ type: "text" as const, text: t }],
  ...(isError && { isError: true }),
});

/** How to run a routine, so Claude can tell the user. */
const howToRun = (name: string) =>
  `Run it from the prompt menu, or in Claude Code as /mcp__stickyinc__${name}.`;

export const routineListSchema = {
  format: z
    .enum(["text", "json"])
    .optional()
    .describe("text (default) to read them, or json to export them for sharing or backup."),
};

export async function handleRoutineList(args: { format?: "text" | "json" }) {
  const routines = listRoutines();
  if (args.format === "json") return text(exportRoutines(routines));
  if (routines.length === 0) {
    return text("No routines yet. Save one with sticky_routine_save, or import some with sticky_routine_import.");
  }
  const lines = routines.map(
    (r) => `• ${r.name}${r.schedule ? ` (${r.schedule})` : ""}\n  ${r.prompt.replace(/\s+/g, " ").slice(0, 160)}`
  );
  return text(`${routines.length} routine${routines.length === 1 ? "" : "s"}:\n\n${lines.join("\n")}\n\n${howToRun("<name>")}`);
}

export const routineSaveSchema = {
  name: z.string().min(1).describe("Short name, e.g. 'waiting on others'; stored as waiting_on_others."),
  prompt: z
    .string()
    .min(1)
    .max(PROMPT_MAX)
    .describe("What to ask when it runs, e.g. 'What am I waiting on from other people? Who should I chase?'"),
  schedule: z
    .string()
    .optional()
    .describe("When it's meant to run, in words ('weekdays at 8:30', 'Fridays at 4pm'). A hint for whatever runs it."),
};

export async function handleRoutineSave(
  args: { name: string; prompt: string; schedule?: string },
  onChange: () => void
) {
  const checked = checkRoutine(args);
  if ("error" in checked) return text(`Can't save that routine: ${checked.error}.`, true);
  const isNew = saveRoutine(checked.routine);
  onChange();
  return text(`${isNew ? "Saved" : "Updated"} routine "${checked.routine.name}". ${howToRun(checked.routine.name)}`);
}

export const routineDeleteSchema = {
  name: z.string().min(1).describe("The routine's name."),
};

export async function handleRoutineDelete(args: { name: string }, onChange: () => void) {
  const name = routineName(args.name) ?? args.name;
  if (!deleteRoutine(name)) return text(`There's no routine called "${name}".`, true);
  onChange();
  return text(`Deleted routine "${name}".`);
}

export const routineImportSchema = {
  json: z
    .string()
    .min(1)
    .describe(
      'Routines as JSON: one {"name", "prompt", "schedule"} object or an array of them, as sticky_routine_list exports. ' +
        "Routines with the same name are replaced."
    ),
};

export async function handleRoutineImport(args: { json: string }, onChange: () => void) {
  const parsed = parseRoutines(args.json);
  if ("error" in parsed) return text(`Nothing imported: ${parsed.error}.`, true);
  const added = parsed.routines.filter((r) => saveRoutine(r)).length;
  onChange();
  const replaced = parsed.routines.length - added;
  return text(
    `Imported ${parsed.routines.map((r) => r.name).join(", ")}` +
      ` (${added} new${replaced ? `, ${replaced} replaced` : ""}). ${howToRun("<name>")}`
  );
}
