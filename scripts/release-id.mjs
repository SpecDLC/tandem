// Resolve the release id of a commit from the git history.
//
// A release commit subject is "Release rel-YYYYMMDD-xxxxxxxx".
// A restore commit subject is "Restore rel-YYYYMMDD-xxxxxxxx". Its tree matches
// that release except for the rollback tooling paths listed below.
// Any other commit uses the newest release commit whose tree matches.
//
// usage:
//   node scripts/release-id.mjs [--repo DIR] [--commit SHA] [--write FILE]
// Exit 0 and print the id. Exit 3 when the tree matches no release. Exit 2 on usage.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

export const RELEASE_SUBJECT = /^Release (rel-\d{8}-[0-9a-f]{8})$/;
export const RESTORE_SUBJECT = /^Restore (rel-\d{8}-[0-9a-f]{8})$/;
// These paths may stay from the current main when a restore commit puts the
// previous release back. The rest of the tree has to match that release.
export const TOOLING_PATHS = [
  ".github/workflows/ci.yml",
  ".github/workflows/deploy.yml",
  ".github/workflows/rollback.yml",
  "scripts/live-version.mjs",
  "scripts/release-id.mjs",
  "scripts/rollback-plan.mjs",
  "test/rollback.test.mjs",
];

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

export function changedPaths(repo, from, to) {
  const raw = git(repo, ["diff", "--name-only", from, to]);
  return raw ? raw.split("\n").filter(Boolean) : [];
}

export function restoreIsHonest(repo, sha, releaseId) {
  const release = listReleaseCommits(repo, sha).find((commit) => commit.release_id === releaseId);
  if (!release) return false;
  return changedPaths(repo, release.sha, sha).every((path) => TOOLING_PATHS.includes(path));
}

export function releaseForCommit(repo, sha) {
  const subject = git(repo, ["log", "-1", "--format=%s", sha]);
  const tree = git(repo, ["rev-parse", `${sha}^{tree}`]);
  const restore = RESTORE_SUBJECT.exec(subject);
  if (restore) {
    if (!restoreIsHonest(repo, sha, restore[1])) return null;
    const release = listReleaseCommits(repo, sha).find((commit) => commit.release_id === restore[1]);
    return { sha: release.sha, release_id: restore[1], tree: git(repo, ["rev-parse", `${release.sha}^{tree}`]) };
  }
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
  const subject = git(repo, ["log", "-1", "--format=%s", full]);
  const found = releaseForCommit(repo, full);
  if (!found && RESTORE_SUBJECT.test(subject)) die(1, `restore commit does not match that release`);
  if (!found) die(3, `no release id for ${full}`);
  if (write) {
    mkdirSync(dirname(write), { recursive: true });
    writeFileSync(write, JSON.stringify({ release_id: found.release_id, commit: full }, null, 2) + "\n");
  }
  console.log(found.release_id);
}
