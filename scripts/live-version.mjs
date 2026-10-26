// Compare a release id to the id the live site publishes in release.json.
//
// usage:
//   node scripts/live-version.mjs --expect rel-YYYYMMDD-xxxxxxxx [--dry-run]
//        [--file PATH | --url URL] [--attempts N] [--interval SECONDS]
//
// --dry-run prints the expected id and does not contact production.
// Exit 0 on a match. Exit 1 when the live id differs. Exit 2 on usage.

import { readFileSync } from "node:fs";

const RELEASE_ID = /^rel-\d{8}-[0-9a-f]{8}$/;
const DEFAULT_URL = "https://tandem.specdlc.com/release.json";

function die(code, msg) {
  console.error(`live-version: ${msg}`);
  process.exit(code);
}

const args = process.argv.slice(2);
let expect = "";
let file = "";
let url = DEFAULT_URL;
let dryRun = false;
let attempts = 1;
let interval = 10;
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  const value = () => {
    const next = args[++i];
    if (next === undefined) die(2, `missing value for ${flag}`);
    return next;
  };
  if (flag === "--expect") expect = value();
  else if (flag === "--file") file = value();
  else if (flag === "--url") url = value();
  else if (flag === "--dry-run") dryRun = true;
  else if (flag === "--attempts") attempts = Number(value());
  else if (flag === "--interval") interval = Number(value());
  else if (flag === "-h" || flag === "--help") {
    console.log("usage: node scripts/live-version.mjs --expect rel-... [--dry-run] [--file PATH | --url URL]");
    process.exit(0);
  } else die(2, `unknown argument ${flag}`);
}

if (!RELEASE_ID.test(expect)) die(2, "--expect must be a release id");
if (!Number.isInteger(attempts) || attempts < 1) die(2, "--attempts must be a positive integer");
if (!Number.isInteger(interval) || interval < 0) die(2, "--interval must be a non-negative integer");

if (dryRun) {
  console.log(`live-version: ${expect} (dry run, production not contacted)`);
  process.exit(0);
}

function readId(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "";
  }
  return typeof parsed.release_id === "string" ? parsed.release_id : "";
}

async function once() {
  if (file) return readId(readFileSync(file, "utf8"));
  const target = new URL(url);
  target.searchParams.set("live-version-check", String(Date.now()));
  const response = await fetch(target, { cache: "no-store", signal: AbortSignal.timeout(15000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`live site returned ${response.status}`);
  return readId(body);
}

let live = "";
for (let n = 1; n <= attempts; n++) {
  try {
    live = await once();
  } catch (error) {
    if (n === attempts) die(1, error instanceof Error ? error.message : String(error));
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    continue;
  }
  if (live === expect) {
    console.log(`live-version: ${live}`);
    process.exit(0);
  }
  if (n === attempts) break;
  await new Promise((resolve) => setTimeout(resolve, interval * 1000));
}
die(1, `expected ${expect} but live id is ${live || "missing"}`);
