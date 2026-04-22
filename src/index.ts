#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { addTaskSchema, handleAddTask } from "./tools/add_task.js";
import { addTaskNaturalSchema, handleAddTaskNatural } from "./tools/add_task_natural.js";
import { listTasksSchema, handleListTasks } from "./tools/list_tasks.js";
import { completeTaskSchema, handleCompleteTask } from "./tools/complete_task.js";
import { scheduleEventSchema, handleScheduleEvent } from "./tools/schedule_event.js";
import { listDoneSchema, handleListDone } from "./tools/list_done.js";

const server = new McpServer({
  name: "stickyinc",
  version: "0.5.0",
});

server.registerTool(
  "add_task",
  {
    title: "Add Task",
    description:
      "Add a todo to StickyInc. The user sees it appear in their floating pane.",
    inputSchema: addTaskSchema,
  },
  handleAddTask
);

server.registerTool(
  "add_task_natural",
  {
    title: "Add Task (natural language)",
    description:
      "Parse a free-text phrase like 'call dentist Friday 3pm' into a task with optional due date, using the configured LLM (Anthropic/OpenRouter/OpenAI).",
    inputSchema: addTaskNaturalSchema,
  },
  handleAddTaskNatural
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
      "Schedule an event. v0.1 stores as a dated task; v0.3 will call Google Calendar create_event.",
    inputSchema: scheduleEventSchema,
  },
  handleScheduleEvent
);

const transport = new StdioServerTransport();
await server.connect(transport);
