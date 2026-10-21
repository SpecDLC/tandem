// Tool registration. One tool per command, named as the command, each calling the same bound function a control calls.
import { COMMAND_NAMES, type CommandName } from "./registry.ts";

type Schema = Record<string, unknown>;
const obj = (properties: Schema = {}, required: string[] = []): Schema => ({ type: "object", properties, required });
const str = (description: string): Schema => ({ type: "string", description });

const SPEC: Record<CommandName, { description: string; inputSchema: Schema; readOnly?: boolean }> = {
  import_tasks: {
    description: "Import tasks. Input is the payload itself: schema \"tandem.tasks/v0\" and a tasks array of { id?, title, estimate_pomodoros?, notes? }. Returns accepted, task_ids, rejected rows with a path, skipped, and ignored_fields. Pass a returned task_id back to start_pomodoro or complete_task.",
    inputSchema: obj({ schema: str("Must be tandem.tasks/v0"), tasks: { type: "array", items: { type: "object" } } }, ["schema", "tasks"]),
  },
  add_task: {
    description: "Add one task. Returns its task_id. Pass that task_id back to start_pomodoro or complete_task.",
    inputSchema: obj({ title: str("Task title"), estimate_pomodoros: { type: "integer", minimum: 0 } }, ["title"]),
  },
  complete_task: {
    description: "Complete an open task by the task_id a previous result returned.",
    inputSchema: obj({ task_id: str("A task_id from import_tasks, add_task, or list_tasks") }, ["task_id"]),
  },
  list_tasks: {
    description: "List tasks with their task_id and status. The optional status filter is open or completed.",
    inputSchema: obj({ status: { type: "string", enum: ["open", "completed"] } }),
    readOnly: true,
  },
  start_pomodoro: {
    description: "Start the one pomodoro on an open task by task_id. Returns pomodoro_id and ends_at. Rejected with pomodoro_already_running while one runs or an in-window paused pomodoro exists.",
    inputSchema: obj({ task_id: str("A task_id from list_tasks") }, ["task_id"]),
  },
  pause_pomodoro: {
    description: "Pause the focus timer. Appends pomodoro_paused with pomodoro_id and remaining_seconds at the pause instant. Rejected with no_running_pomodoro outside focus.",
    inputSchema: obj(),
  },
  resume_pomodoro: {
    description: "Resume a paused pomodoro by pomodoro_id. Appends pomodoro_resumed with ends_at set to now plus the frozen remaining seconds. Rejected with pomodoro_already_running when another pomodoro is running or paused inside the roll-off window.",
    inputSchema: obj({ pomodoro_id: str("The pomodoro_id of a paused card, including one past the roll-off window") }, ["pomodoro_id"]),
  },
  stop_pomodoro: {
    description: "Stop the running pomodoro, or the in-window paused one (Close). Pass pomodoro_id to close that paused card, including one past the roll-off window. Appends pomodoro_stopped. Rejected with no_running_pomodoro when nothing matches.",
    inputSchema: obj({ pomodoro_id: str("Optional. A paused card to close, including one past the roll-off window. Omit to stop the running or in-window paused pomodoro.") }),
  },
  get_status: {
    description: "Read the phase (idle, focus, break, or paused), the task, the seconds remaining, and the in-window paused list. Uses the default 3-day roll-off and omits stale paused sessions.",
    inputSchema: obj(),
    readOnly: true,
  },
  export_events: {
    description: "Return session events after since_cursor, in append order, with a new cursor. Omit since_cursor for all events. Pass the returned cursor back next time. An unknown cursor returns unknown_cursor and no events.",
    inputSchema: obj({ since_cursor: str("A cursor a previous export_events returned") }),
    readOnly: true,
  },
  import_events: {
    description: "Append session events unchanged, ids included. Input is { events: [...] }. Events already present are skipped by id.",
    inputSchema: obj({ events: { type: "array", items: { type: "object" } } }, ["events"]),
  },
};

/** How a tool's input object becomes the command's arguments. A control builds the same arguments from the page. */
const ARGS: Record<CommandName, (i: Record<string, unknown>) => unknown[]> = {
  import_tasks: (i) => [i],
  add_task: (i) => [i.title, i.estimate_pomodoros],
  complete_task: (i) => [i.task_id],
  list_tasks: (i) => [i.status],
  start_pomodoro: (i) => [i.task_id],
  pause_pomodoro: () => [],
  resume_pomodoro: (i) => [i.pomodoro_id],
  stop_pomodoro: (i) => [i.pomodoro_id],
  get_status: () => [],
  export_events: (i) => [i.since_cursor],
  import_events: (i) => [i.events],
};

/** Register every command on document.modelContext. `after` runs once the agent's command is done. It sees the name and the result, never an actor. */
export async function registerTools(
  context: NonNullable<Document["modelContext"]>,
  commands: Record<CommandName, (...a: never[]) => unknown>,
  after: (name: CommandName, result: unknown) => void,
): Promise<void> {
  for (const name of COMMAND_NAMES) {
    const run = commands[name] as (...a: unknown[]) => unknown;
    await context.registerTool({
      name,
      description: SPEC[name].description,
      inputSchema: SPEC[name].inputSchema,
      annotations: { readOnlyHint: SPEC[name].readOnly === true },
      execute: async (input: Record<string, unknown>) => {
        const r = await run(...ARGS[name](input ?? {}));
        after(name, r);
        return r;
      },
    });
  }
}
