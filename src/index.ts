#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { addTaskSchema, handleAddTask } from "./tools/add_task.js";
import { addTaskNaturalSchema, handleAddTaskNatural } from "./tools/add_task_natural.js";
import { listTasksSchema, handleListTasks } from "./tools/list_tasks.js";
import { completeTaskSchema, handleCompleteTask } from "./tools/complete_task.js";
import { scheduleEventSchema, handleScheduleEvent } from "./tools/schedule_event.js";
import { listDoneSchema, handleListDone } from "./tools/list_done.js";
import { stickySearchSchema, handleStickySearch } from "./tools/sticky_search.js";
import { clientLabel } from "./provenance.js";

const server = new McpServer({
  name: "stickyinc",
  version: "0.5.2",
});

/** The connected app, from the MCP handshake; tasks record it as provenance. */
const client = () => clientLabel(server.server.getClientVersion());

server.registerTool(
  "add_task",
  {
    title: "Add Task",
    description:
      "Add a todo to StickyInc. The user sees it appear in their floating pane, and hovering " +
      "over it shows context.excerpt: quote their words so they can tell where it came from.",
    inputSchema: addTaskSchema,
  },
  (args) => handleAddTask(args, client())
);

server.registerTool(
  "add_task_natural",
  {
    title: "Add Task (natural language)",
    description:
      "Parse a free-text phrase like 'call dentist Friday 3pm' into a task with optional due date, using the configured LLM (Anthropic/OpenRouter/OpenAI).",
    inputSchema: addTaskNaturalSchema,
  },
  (args) => handleAddTaskNatural(args, client())
);

server.registerTool(
  "list_tasks",
  {
    title: "List Tasks",
    description: "List open StickyInc tasks (or all, with include_completed=true).",
    inputSchema: listTasksSchema,
  },
  handleListTasks
);

server.registerTool(
  "complete_task",
  {
    title: "Complete Task",
    description: "Mark a StickyInc task done by id.",
    inputSchema: completeTaskSchema,
  },
  handleCompleteTask
);

server.registerTool(
  "list_done",
  {
    title: "List Done",
    description:
      "List recently completed StickyInc tasks, with optional archive of older completions.",
    inputSchema: listDoneSchema,
  },
  handleListDone
);

server.registerTool(
  "schedule_event",
  {
    title: "Schedule Event",
    description:
      "Save an event as a StickyInc task due at its start time. StickyInc doesn't sync calendars; use a calendar connector for that.",
    inputSchema: scheduleEventSchema,
  },
  (args) => handleScheduleEvent(args, client())
);

server.registerTool(
  "sticky_search",
  {
    title: "Search Tasks",
    description:
      "Search everything the user has put in StickyInc, open and done, by words in the task or in " +
      "what they said when it was added, optionally only since a date. Use it to remind them what " +
      "they committed to and when, e.g. \"you said you'd call the dentist three weeks ago\". " +
      "Returns up to 20 tasks, best match first.",
    inputSchema: stickySearchSchema,
  },
  handleStickySearch
);

const transport = new StdioServerTransport();
await server.connect(transport);
