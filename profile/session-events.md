# Session event profile

The session log is **CloudEvents 1.0** in structured JSON mode. One event per line, UTF-8, each line ending in a newline. This is how Tandem interoperates with other event logs. A consumer that ignores attributes it does not know can still read the core.

```json
{"specversion":"1.0","id":"01J0TANDEMEVENTID0000000001","source":"urn:specdlc:tandem","type":"com.specdlc.tandem.task_imported.v1","subject":"01J0TANDEMTASKID00000000001","time":"2026-10-14T18:00:00.000Z","datacontenttype":"application/json","dataschema":"urn:specdlc:schema:tandem.session:1","actor":"human:local","data":{"task_id":"01J0TANDEMTASKID00000000001","title":"Draft spec intro"}}
```

## Attributes

- `source` is `urn:specdlc:tandem` on every conformant log.
- `id` is a ULID. A runtime mints it for events it creates. `import_events` keeps the id it was given.
- `subject` is the task id or pomodoro id the event concerns.
- `time` is ISO-8601 UTC.
- `actor` is a CloudEvents extension. Its kind is `human` or `agent`: `human:local` for a control, `agent:local` for a tool call.
- `data` holds the domain payload. Absent optional fields are omitted.

## Types

Action in past tense.

| Type | Data key order |
|---|---|
| `com.specdlc.tandem.task_imported.v1` | `task_id`, `title`, then `estimate_pomodoros` and `notes` when present |
| `com.specdlc.tandem.task_added.v1` | same as imported |
| `com.specdlc.tandem.task_completed.v1` | `task_id` |
| `com.specdlc.tandem.pomodoro_started.v1` | `pomodoro_id`, `task_id`, `focus_seconds`, `break_seconds`, `ends_at` |
| `com.specdlc.tandem.pomodoro_stopped.v1` | `pomodoro_id` |
| `com.specdlc.tandem.pomodoro_finished.v1` | `pomodoro_id`, `task_id` |

`pomodoro_finished` is internal. The timer records it when the clock reaches the scheduled end. It is not a command. Its actor kind copies the matching start. Its `time` is the scheduled end.

## Cursor

`export_events(since_cursor)` walks append order, not ULID magnitude. An omitted or empty cursor returns every event and the new cursor is the last event id. A known cursor returns only events after that id. An empty log returns no events and an empty cursor. An unknown cursor returns `unknown_cursor` and no events.

## Schema for `data`

Closed: no property outside the lists below.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "oneOf": [
    {
      "type": "object", "additionalProperties": false, "required": ["task_id", "title"],
      "properties": {
        "task_id": { "type": "string", "minLength": 1 },
        "title": { "type": "string", "minLength": 1 },
        "estimate_pomodoros": { "type": "integer", "minimum": 0 },
        "notes": { "type": "string" }
      }
    },
    {
      "type": "object", "additionalProperties": false, "required": ["task_id"],
      "properties": { "task_id": { "type": "string", "minLength": 1 } }
    },
    {
      "type": "object", "additionalProperties": false,
      "required": ["pomodoro_id", "task_id", "focus_seconds", "break_seconds", "ends_at"],
      "properties": {
        "pomodoro_id": { "type": "string", "minLength": 1 },
        "task_id": { "type": "string", "minLength": 1 },
        "focus_seconds": { "const": 1500 },
        "break_seconds": { "const": 300 },
        "ends_at": { "type": "string", "format": "date-time" }
      }
    },
    {
      "type": "object", "additionalProperties": false, "required": ["pomodoro_id"],
      "properties": { "pomodoro_id": { "type": "string", "minLength": 1 } }
    },
    {
      "type": "object", "additionalProperties": false, "required": ["pomodoro_id", "task_id"],
      "properties": { "pomodoro_id": { "type": "string", "minLength": 1 }, "task_id": { "type": "string", "minLength": 1 } }
    }
  ]
}
```

A type selects one branch: imported and added use the first, completed the second, started the third, stopped the fourth, finished the fifth.
