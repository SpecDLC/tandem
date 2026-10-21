# TANDEM-ENG-1 (draft)

**Claim.** A board exported as the event log, wiped, and imported back is the same board: same tasks, ids, order, status and text, and a byte-identical exported log. Importing the same log a second time changes nothing. Every event's actor comes from one of the two channels, the on-page button (`human:local`) or the WebMCP tool (`agent:local`).

**Interface.** The page controls (Import, Export log) and the WebMCP tools on `document.modelContext` (`import_events`, `export_events`, `add_task`, `complete_task`), read through the screen hooks and the exported JSONL.

**Forbids.** A replayed board that differs from the original in any task, id, order or status; a second import that appends, reorders or alters any event; an event whose actor is not `human:local` or `agent:local`; importing through the WebMCP tools; an import that rewrites the actors recorded on imported events.

**Done when.**
- `test/witness/replay.witness.mjs` passes in CI: it builds a board through both channels, exports it, opens a fresh (empty) working copy, imports through WebMCP, and checks the board and log match, then imports again and checks nothing changed. **Passing.**
- **Pending:** an in-app wipe command exists and the witness uses it instead of a fresh working copy.
- **Pending:** `import_events` rejects an event whose actor is not `human:local` or `agent:local` (today it accepts any `human:` or `agent:` actor), with a witness that fails first.
- **Pending:** the import is recorded as its own event, stamped with whoever ran it.
- **Pending:** until the app has a wipe command, the replay passes in a fresh browser profile (a clean board, not the same tab reloaded).
