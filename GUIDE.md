# Guide

This guide tells any agent how to build a Tandem runtime from the cards, then walks one session through it. It does not require any template. You need only this repository and Node 18 or later for the replay.

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

## Walkthrough: one session, two drivers

This shows what a conformant runtime writes. The ids below are made up; a runtime mints its own ULIDs. Each block is a file you can create and run.

### 1. A person starts a pomodoro

The person imports a task, then presses start on it. The controls call the same commands the tools do, so the runtime appends:

```json
{"specversion":"1.0","id":"01J0TANDEMEVENT0000000001","source":"urn:specdlc:tandem","type":"com.specdlc.tandem.task_imported.v1","subject":"01J0TANDEMTASK00000000001","time":"2026-10-14T18:00:00.000Z","datacontenttype":"application/json","dataschema":"urn:specdlc:schema:tandem.session:1","actor":"human:local","data":{"task_id":"01J0TANDEMTASK00000000001","title":"Draft spec intro"}}
{"specversion":"1.0","id":"01J0TANDEMEVENT0000000002","source":"urn:specdlc:tandem","type":"com.specdlc.tandem.pomodoro_started.v1","subject":"01J0TANDEMPOMO00000000001","time":"2026-10-14T18:01:00.000Z","datacontenttype":"application/json","dataschema":"urn:specdlc:schema:tandem.session:1","actor":"human:local","data":{"pomodoro_id":"01J0TANDEMPOMO00000000001","task_id":"01J0TANDEMTASK00000000001","focus_seconds":1500,"break_seconds":300,"ends_at":"2026-10-14T18:26:00.000Z"}}
```

### 2. An agent starts a pomodoro

An agent with the tools and nothing else runs the **Start my day** routine above: `import_tasks`, `list_tasks`, `start_pomodoro` with the returned `task_id`. The runtime appends the same two types:

```json
{"specversion":"1.0","id":"01J0TANDEMEVENT0000000011","source":"urn:specdlc:tandem","type":"com.specdlc.tandem.task_imported.v1","subject":"01J0TANDEMTASK00000000011","time":"2026-10-15T09:00:00.000Z","datacontenttype":"application/json","dataschema":"urn:specdlc:schema:tandem.session:1","actor":"agent:local","data":{"task_id":"01J0TANDEMTASK00000000011","title":"Draft spec intro"}}
{"specversion":"1.0","id":"01J0TANDEMEVENT0000000012","source":"urn:specdlc:tandem","type":"com.specdlc.tandem.pomodoro_started.v1","subject":"01J0TANDEMPOMO00000000011","time":"2026-10-15T09:01:00.000Z","datacontenttype":"application/json","dataschema":"urn:specdlc:schema:tandem.session:1","actor":"agent:local","data":{"pomodoro_id":"01J0TANDEMPOMO00000000011","task_id":"01J0TANDEMTASK00000000011","focus_seconds":1500,"break_seconds":300,"ends_at":"2026-10-15T09:26:00.000Z"}}
```

### 3. Compare

The two `pomodoro_started` events are the same kind of CloudEvent. `specversion`, `source`, `type`, `datacontenttype`, `dataschema`, and the shape and key order of `data` are identical. Only the values that belong to the session differ (`id`, `subject`, `time`, ids and `ends_at` in `data`) and `actor`: `human:local` for a control, `agent:local` for a tool call. A reader that knows only CloudEvents 1.0 can list `id`, `source`, `type`, `subject`, and `time` from either (TANDEM-TECH-CE-1).

When the clock reaches `ends_at` the timer appends `pomodoro_finished` on its own, with the actor kind of the start. No command writes it.

### 4. Sync and replay

Save the four lines above to a file, in that order, as `session.jsonl`. Sync is one `export_events` result piped through the script. With a runtime you would pass its result; here the result is built from the file so you can run it yourself:

```sh
node -e 'const l=require("fs").readFileSync("session.jsonl","utf8").trim().split("\n").map(JSON.parse);console.log(JSON.stringify({events:l,cursor:l.at(-1).id}))' > result.json
node scripts/sync-jsonl.mjs synced.jsonl < result.json   # appended 4, skipped 0, cursor 01J0TANDEMEVENT0000000012
node scripts/sync-jsonl.mjs synced.jsonl < result.json   # appended 0, skipped 4, cursor 01J0TANDEMEVENT0000000012
```

The second run adds nothing: events are skipped by `id`. Now replay `synced.jsonl` into a task list and a phase. Save this as `replay.mjs`:

```js
import { readFileSync } from "node:fs";
const events = readFileSync(process.argv[2], "utf8").trim().split("\n").map((l) => JSON.parse(l));
const tasks = new Map();
const pomodoros = new Map();
for (const e of events) {
  if (e.type.includes(".task_imported.") || e.type.includes(".task_added."))
    tasks.set(e.data.task_id, { title: e.data.title, status: "open" });
  else if (e.type.includes(".task_completed.")) tasks.get(e.data.task_id).status = "completed";
  else if (e.type.includes(".pomodoro_started.")) pomodoros.set(e.data.pomodoro_id, { ...e.data, phase: "focus" });
  else if (e.type.includes(".pomodoro_stopped.")) pomodoros.delete(e.data.pomodoro_id);
  else if (e.type.includes(".pomodoro_finished.")) pomodoros.get(e.data.pomodoro_id).phase = "break";
}
console.log([...tasks].map(([id, t]) => `${id} ${t.status} ${t.title}`).join("\n"));
console.log("pomodoros:", [...pomodoros.values()].map((p) => `${p.pomodoro_id} ${p.phase}`).join(", ") || "none");
```

```sh
node replay.mjs synced.jsonl
# 01J0TANDEMTASK00000000001 open Draft spec intro
# 01J0TANDEMTASK00000000011 open Draft spec intro
# pomodoros: 01J0TANDEMPOMO00000000001 focus, 01J0TANDEMPOMO00000000011 focus
```

This is the replay a runtime must match: after a reset, replaying the synced file gives the same task list and phase the session showed (TANDEM-TECH-LOG-3). Compare it with the screen and the tool results using **Confirm** above.
