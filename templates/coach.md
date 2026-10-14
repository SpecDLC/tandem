# Coach: "start my day"

Optional. A routine for an agent that has the Tandem tools and nothing else. Do not click or script the page.

1. Call `import_tasks` with today's tasks as a `tandem.tasks/v0` payload (see `schema/tandem.tasks.v0.json`).
2. Call `list_tasks` with status `open`. Use the returned `task_id` values; do not guess ids.
3. Call `start_pomodoro` with the first returned `task_id`. Keep the returned `pomodoro_id`.
4. Call `get_status` until `phase` is `break`.
5. Report the task title and the `pomodoro_id` to the person.

Do not complete tasks or stop a pomodoro unless the person asks.
