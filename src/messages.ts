// Friendly copy for rejection codes. The codes themselves are unchanged: agents still get
// { ok: false, code } from every command. Only the human-facing page translates them.
// Codes marked "seen" appear in tools.ts or main.ts; the rest are guesses to confirm against registry.ts.

export type Friendly = { title: string; body: string };

const MESSAGES: Record<string, Friendly> = {
  missing_title:            { title: "That task needs a title", body: "Type what you want to work on, then press Enter." },
  pomodoro_already_running: { title: "A timer is already running", body: "Stop it first, or use Switch on the task you want to move to." },
  no_running_pomodoro:      { title: "Nothing to stop", body: "No timer is running right now." },
  no_paused_pomodoro:       { title: "Nothing to resume", body: "That pomodoro is not paused." },
  unknown_cursor:           { title: "That log position isn't recognised", body: "Export the full log instead, without a cursor." },
  unknown_task:             { title: "Couldn't find that task", body: "It may have been completed. The list has been refreshed." },
  task_not_open:            { title: "That task is already done", body: "Only open tasks can be started or completed." },
  invalid_event:            { title: "Some log lines couldn't be read", body: "Each line must be one JSON event from an exported Tandem log." },
  invalid_payload:          { title: "That text isn't a task list", body: "Check the JSON. A task import needs \"schema\": \"tandem.tasks/v0\" and a tasks array." },
  unsupported_schema:       { title: "That file isn't a Tandem task list", body: "Task imports need \"schema\": \"tandem.tasks/v0\" and a tasks array." },
  invalid_events:           { title: "That text isn't a Tandem log", body: "Import a list of events exported from Tandem." },
  duplicate_id:             { title: "That one is already in the list", body: "The duplicate was skipped." },
  stale_cursor:             { title: "The board changed", body: "Export the log again and retry with the new cursor." },
};

const FALLBACK: Friendly = { title: "Something didn't work", body: "Try again. If it keeps happening, open Advanced and export the log." };

/** Friendly message for a code. The raw code is kept in data-code for tests and shown in Advanced. */
export function friendly(code: string | undefined): Friendly {
  return (code && MESSAGES[code]) || FALLBACK;
}

/** Import rows: "missing_title at tasks[2].title" becomes "Row 3: that task needs a title". */
export function friendlyRow(code: string, path: string): string {
  const m = /tasks\[(\d+)\]|events\[(\d+)\]|^\[(\d+)\]/.exec(path);
  const n = m ? Number(m[1] ?? m[2] ?? m[3]) + 1 : undefined;
  const msg = friendly(code).title;
  return n ? `Row ${n}: ${msg.charAt(0).toLowerCase()}${msg.slice(1)}` : msg;
}

/** Fill the [data-rejection] notice. Replaces `rejection.textContent = r.code` in main.ts's run(). */
export function showRejection(target: HTMLElement, code: string | undefined): void {
  const { title, body } = friendly(code);
  target.dataset.code = code ?? "";
  target.innerHTML = `<svg aria-hidden="true" width="22" height="22" viewBox="0 0 22 22"><path d="M11 2 21 20H1Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M11 9v5" stroke="currentColor" stroke-width="2"/><circle cx="11" cy="17" r="1.2" fill="currentColor"/></svg>`;
  const text = document.createElement("div");
  const t = Object.assign(document.createElement("p"), { className: "notice__title", textContent: title });
  const b = Object.assign(document.createElement("p"), { className: "notice__body", textContent: body });
  text.append(t, b);
  target.append(text);
}
