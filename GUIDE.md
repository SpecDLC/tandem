# Guide (outline)

This guide tells any agent how to build a Tandem runtime from the cards. It does not require any template. The full walkthrough is still to be written; this is the outline.

1. **Read the contract.** Start at [spec/SPECIFICATION.md](spec/SPECIFICATION.md). Each member links to a card with a claim, an interface, and what would refute it.
2. **Offer the commands.** Nine commands, the same for a person and an agent: `import_tasks`, `add_task`, `complete_task`, `list_tasks`, `start_pomodoro`, `stop_pomodoro`, `get_status`, `export_events`, `import_events`. See TANDEM-FUNC-PARITY-1.
3. **Write only events.** Every command that changes state appends a CloudEvents 1.0 event as in [profile/session-events.md](profile/session-events.md). Nothing rewrites an earlier line.
4. **Validate imports.** Task payloads follow [schema/tandem.tasks.v0.json](schema/tandem.tasks.v0.json).
5. **Run one pomodoro.** Focus 1500 seconds, break 300 seconds. The finish event is recorded by the timer, never by a command.
6. **Export and sync.** `export_events(since_cursor)` returns later events and a new cursor. [scripts/sync-jsonl.mjs](scripts/sync-jsonl.mjs) appends events whose ids are not yet in the file. Defaults: [templates/sync.md](templates/sync.md).
7. **Confirm.** Show that the screen, the tools, and the exported log agree, and name the first disagreement.

To do in the teaching-guide slice: walk one session from a person and from an agent to the same kind of CloudEvent, then replay the synced JSONL.
