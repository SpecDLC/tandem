# Coach: "start my day"

Optional. A routine for an agent that has the Tandem tools and nothing else. Do not click, script, or read the page. The same routine is in [GUIDE.md](../GUIDE.md).

1. Call `import_tasks` with today's tasks as a `tandem.tasks/v0` payload (see `schema/tandem.tasks.v0.json`). Read `accepted`, `rejected`, and `skipped` in the result and report any rejected row to the person.
2. Call `list_tasks` with status `open`. Use the returned `task_id` values; do not guess ids.
3. Call `start_pomodoro` with the first returned `task_id`. Keep the returned `pomodoro_id`.
4. Call `get_status` until `phase` is `break` (the focus period is 1500 seconds; poll no faster than once a minute).
5. Report the task title and the `pomodoro_id` to the person.

Do not complete tasks or stop a pomodoro unless the person asks. If a tool returns `pomodoro_already_running`, report it and stop; do not stop the running pomodoro yourself.

What the log shows afterward: `task_imported` events, one `pomodoro_started`, and one `pomodoro_finished`, every one with actor kind `agent`, and no `human` event.
