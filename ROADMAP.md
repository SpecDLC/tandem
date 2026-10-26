Maintainer: Texian (SpecDLC Grok Bot).

# Roadmap

This page is maintained by hand. It is not generated from the ledger.

## Planned

Later. Not built in this tree.

- Finished-focus prompt
- ADHD-mode preferences
- Import that merges by event id
- Sync endpoint (append and read since N)
- Keypair auth
- Per-event signatures
- Pictures into tasks
- A shared pomodoro

## Shipped

Behavior on `origin/main` at `b2f31f73d90b276ae5328c46f7668b3ec160c970`. Checked with `npm test` (31 passed, `test/*.test.mjs`) and `node tools/project.mjs --check release/public` (20 files).

- Task import accepts 4, rejects 1 with a path, skips 1, and reports an unknown field without storing it. A wrong or missing schema writes nothing (`test/session.test.mjs`).
- `add_task` and `complete_task` follow the session rules. Rapid adds keep every title in commit order (`test/session.test.mjs`).
- A pomodoro can start, stop, finish, and move through break and idle. A second start is rejected while one is running. Start during break is allowed. Finish copies the start actor and uses the scheduled end (`test/session.test.mjs`).
- The same domain facts come from a human call and an agent call. The same invalid input is rejected the same way (`test/session.test.mjs`).
- Exported events are CloudEvents 1.0, one JSON object per line, with ULID ids. The official CloudEvents SDK accepts them. An export is a byte prefix of a later export. Replaying the JSONL matches the live projection. Discard and import restores the list and keeps ids (`test/session.test.mjs`).
- An export cursor walks append order. Reading the same cursor again adds no duplicate id. `import_events` keeps ids, skips duplicates, and does not re-run the command rules (`test/session.test.mjs`).
- Two starts at the same time yield one pomodoro (`test/session.test.mjs`).
- Pause and resume are events. The same clock paints the same board. A stale paused card closes by stopping that pomodoro, and omitting the id writes nothing (`test/session.test.mjs`). Paused text fades with age, keeps text at 4.5:1 and controls at 3:1, and the resume and close controls declare a 44px minimum (`test/pausedFade.test.mjs`).
- The activity feed folds forward and shows the newest four lines. Relative time stays on the minute. The log keeps the stamped actor, and a reload is not a fresh change. The focus starter follows the latest start event (`test/activity.test.mjs`).
- The command registry names the declared commands (`test/session.test.mjs`).
- The public cards, specification, connections, and requirements match the ledger (`node tools/project.mjs --check release/public`).

## Open

The current version. Not on `origin/main`, and not shipped.

- Actor on each new event
- Configurable focus length
- In-page agent commands
- Format-version export header with whole-file import checks
