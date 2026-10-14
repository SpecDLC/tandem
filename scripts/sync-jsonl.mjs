#!/usr/bin/env node
// Append exported events to a JSONL file, skipping any event whose id is already present.
// usage: echo '{"events":[...],"cursor":"..."}' | node sync-jsonl.mjs FILE
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const file = process.argv[2];
if (!file) { console.error("usage: sync-jsonl.mjs FILE < result.json"); process.exit(2); }
const { events } = JSON.parse(readFileSync(0, "utf8"));
if (!Array.isArray(events)) { console.error("input has no events array"); process.exit(2); }

const seen = new Set();
if (existsSync(file)) {
  const text = readFileSync(file, "utf8");
  for (const line of text.split("\n")) if (line.trim()) seen.add(JSON.parse(line).id);
} else {
  mkdirSync(dirname(file), { recursive: true });
}
let out = "", appended = 0, skipped = 0;
for (const e of events) {
  if (seen.has(e.id)) { skipped++; continue; }
  seen.add(e.id);
  out += JSON.stringify(e) + "\n";
  appended++;
}
if (out) appendFileSync(file, out);
console.log(`appended ${appended}, skipped ${skipped}`);
