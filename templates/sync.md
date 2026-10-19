# Sync

Copy the exported session log to a JSONL file on your computer. Any agent can run these steps; the same routine is in [GUIDE.md](../GUIDE.md) for an agent that ignores this template.

Defaults (edit here; no code change needed):

- **Path:** `~/Tandem/events.jsonl`
- **Schedule:** every 15 minutes while the machine is on

Steps:

1. Read the cursor you stored from the last run. On the first run it is empty.
2. Call the tool `export_events` with `since_cursor` set to that cursor (omit it when empty). It returns `{ events, cursor }` and walks append order, not id order.
   An `unknown_cursor` result means the session was reset: stop and tell the person. Do not write anything.
3. Run the script with the result on stdin:

   ```sh
   echo '{"events":[...],"cursor":"..."}' | node scripts/sync-jsonl.mjs ~/Tandem/events.jsonl
   ```

   It appends every event whose `id` is not already in the file and prints `appended N, skipped M`. A second run with the same events appends nothing. The script is a convenience: any program that appends events with unseen ids to the file does the same job.
4. Store the returned `cursor` for the next run. If the returned cursor is empty (empty log), keep the old one.

The synced file replays to the same task list and `get_status` phase the session shows (TANDEM-TECH-LOG-3).
