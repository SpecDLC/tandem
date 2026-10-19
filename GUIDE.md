# Guide (outline)

This guide tells any agent how to build a Tandem runtime from the cards. It does not require any template. The full walkthrough is still to be written; this is the outline.

1. **Read the contract.** Start at [spec/SPECIFICATION.md](spec/SPECIFICATION.md). Each member links to a card with a claim, an interface, and what would refute it.
2. **Offer the commands.** Nine commands, the same for a person and an agent: `import_tasks`, `add_task`, `complete_task`, `list_tasks`, `start_pomodoro`, `stop_pomodoro`, `get_status`, `export_events`, `import_events`. See TANDEM-FUNC-PARITY-1.
3. **Write only events.** Every command that changes state appends a CloudEvents 1.0 event as in [profile/session-events.md](profile/session-events.md). Nothing rewrites an earlier line.
4. **Validate imports.** Task payloads follow [schema/tandem.tasks.v0.json](schema/tandem.tasks.v0.json).
5. **Run one pomodoro.** Focus 1500 seconds, break 300 seconds. The finish event is recorded by the timer, never by a command.
6. **Export and sync.** `export_events(since_cursor)` returns later events and a new cursor. [scripts/sync-jsonl.mjs](scripts/sync-jsonl.mjs) appends events whose ids are not yet in the file. Defaults: [templates/sync.md](templates/sync.md).
7. **Confirm.** Show that the screen, the tools, and the exported log agree, and name the first disagreement.

## Routines

Two routines run on the tools alone. An agent that ignores [templates/coach.md](templates/coach.md) and [templates/sync.md](templates/sync.md) can run them from here.

**Start my day** (coach). Use only the tools; never click the page.

1. `import_tasks` with a `tandem.tasks/v0` payload. Report any `rejected` row.
2. `list_tasks` with status `open`. Take `task_id` values from the result.
3. `start_pomodoro` with the first `task_id`. Keep the `pomodoro_id`.
4. `get_status` until `phase` is `break`.
5. Tell the person the task title and the `pomodoro_id`.

The log then holds import, start, and finish events with actor kind `agent` and no `human` event (TANDEM-FUNC-COACH-1).

**Sync** (default path `~/Tandem/events.jsonl`, every 15 minutes while the machine is on).

1. Read the stored cursor; it is empty on the first run.
2. `export_events` with `since_cursor` set to it. `unknown_cursor` means the session was reset: stop, write nothing, tell the person.
3. Append every returned event whose `id` is not already in the file, one JSON object per line (`node scripts/sync-jsonl.mjs FILE` does this from `{ events, cursor }` on stdin). A second run with the same events adds nothing.
4. Store the returned cursor.

Replaying the file gives the same task list and `get_status` phase the session shows (TANDEM-TECH-LOG-3).

**Confirm** (TANDEM-FUNC-DEBUG-1). Read three views of one session: the screen (task list and header), the tool results (`list_tasks`, `get_status`), and the synced log replayed. Compare them in this order and name the first disagreement: task ids and order, then each task's status, then the phase, then the title of the running or break task. Report `agree` when all four match.

To do in the teaching-guide slice: walk one session from a person and from an agent to the same kind of CloudEvent, then replay the synced JSONL.
