# Sync

Copy the exported session log to a JSONL file on your computer. Any agent can run these steps.

Defaults (edit here; no code change needed):

- **Path:** `~/Tandem/events.jsonl`
- **Schedule:** every 15 minutes while the machine is on

Steps:

1. Read the cursor you stored from the last run. On the first run it is empty.
2. Call the tool `export_events` with `since_cursor` set to that cursor. It returns `{ events, cursor }`.
   An `unknown_cursor` result means the session was reset: stop and tell the person.
3. Run the script with the result on stdin:

   ```sh
   echo '{"events":[...],"cursor":"..."}' | node scripts/sync-jsonl.mjs ~/Tandem/events.jsonl
   ```

   It appends every event whose `id` is not already in the file and prints `appended N, skipped M`. A second run with the same events appends nothing.
4. Store the returned `cursor` for the next run.
