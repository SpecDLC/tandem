#!/usr/bin/env node
// Append exported events to a JSONL file, skipping any event whose id is already present.
// usage: echo '{"events":[...],"cursor":"..."}' | node sync-jsonl.mjs FILE
// Plain Node. Imports no application module. Prints "appended N, skipped M" and the cursor to store next.
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const fail = (msg) => { console.error(msg); process.exit(2); };

const file = process.argv[2];
if (!file) fail("usage: sync-jsonl.mjs FILE < result.json");

let result;
try { result = JSON.parse(readFileSync(0, "utf8")); } catch { fail("input is not JSON"); }
// A rejected export (for example unknown_cursor) carries no events to trust. Write nothing.
if (result.ok === false) fail(`export was rejected: ${result.code ?? "unknown"}`);
if (!Array.isArray(result.events)) fail("input has no events array");

const seen = new Set();
let needsNewline = false;
if (existsSync(file)) {
  const text = readFileSync(file, "utf8");
  needsNewline = text.length > 0 && !text.endsWith("\n");
  for (const line of text.split("\n")) if (line.trim()) seen.add(JSON.parse(line).id);
} else {
  mkdirSync(dirname(file), { recursive: true });
}

let out = needsNewline ? "\n" : "", appended = 0, skipped = 0;
for (const e of result.events) {
  if (typeof e?.id !== "string" || e.id === "") fail("an event has no id");
  if (seen.has(e.id)) { skipped++; continue; }
  seen.add(e.id);
  out += JSON.stringify(e) + "\n";
  appended++;
}
if (appended) appendFileSync(file, out);
console.log(`appended ${appended}, skipped ${skipped}, cursor ${result.cursor ?? ""}`);
