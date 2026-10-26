// Resolve the release id of a commit from the git history.
//
// A release commit subject is "Release rel-YYYYMMDD-xxxxxxxx".
// The id of any other commit is the newest release commit whose tree matches.
// The id is not stored in the tree. A revert commit keeps the previous tree
// and a new message, so the tree is the lookup key.
//
// usage:
//   node scripts/release-id.mjs [--repo DIR] [--commit SHA] [--write FILE]
// Exit 0 and print the id. Exit 3 when the tree matches no release. Exit 2 on usage.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

export const RELEASE_SUBJECT = /^Release (rel-\d{8}-[0-9a-f]{8})$/;

export function git(repo, args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

export function listReleaseCommits(repo, head = "HEAD") {
  const raw = git(repo, ["log", "--format=%H%x09%s", head]);
  if (!raw) return [];
  const out = [];
  for (const line of raw.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 1) continue;
    const match = RELEASE_SUBJECT.exec(line.slice(tab + 1));
    if (match) out.push({ sha: line.slice(0, tab), release_id: match[1] });
  }
  return out;
}

export function releaseForTree(repo, tree, head = "HEAD") {
  for (const commit of listReleaseCommits(repo, head)) {
    if (git(repo, ["rev-parse", `${commit.sha}^{tree}`]) === tree) return commit;
  }
  return null;
}

export function releaseForCommit(repo, sha) {
  const subject = git(repo, ["log", "-1", "--format=%s", sha]);
  const tree = git(repo, ["rev-parse", `${sha}^{tree}`]);
  const match = RELEASE_SUBJECT.exec(subject);
  if (match) return { sha, release_id: match[1], tree };
  const found = releaseForTree(repo, tree, sha);
  return found ? { sha: found.sha, release_id: found.release_id, tree } : null;
}

function die(code, msg) {
  console.error(`release-id: ${msg}`);
  process.exit(code);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const args = process.argv.slice(2);
  let repo = ".";
  let commit = "HEAD";
  let write = "";
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = () => {
      const next = args[++i];
      if (next === undefined) die(2, `missing value for ${flag}`);
      return next;
    };
    if (flag === "--repo") repo = value();
    else if (flag === "--commit") commit = value();
    else if (flag === "--write") write = value();
    else if (flag === "-h" || flag === "--help") {
      console.log("usage: node scripts/release-id.mjs [--repo DIR] [--commit SHA] [--write FILE]");
      process.exit(0);
    } else die(2, `unknown argument ${flag}`);
  }
  let full;
  try {
    full = git(repo, ["rev-parse", "--verify", `${commit}^{commit}`]);
  } catch {
    die(2, `not a commit: ${commit}`);
  }
  const found = releaseForCommit(repo, full);
  if (!found) die(3, `no release id for ${full}`);
  if (write) {
    mkdirSync(dirname(write), { recursive: true });
    writeFileSync(write, JSON.stringify({ release_id: found.release_id, commit: full }, null, 2) + "\n");
  }
  console.log(found.release_id);
}
