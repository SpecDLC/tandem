// Plan a rollback of SpecDLC/tandem. This script never pushes and never deploys.
//
//   node scripts/rollback-plan.mjs --repo DIR --mode revert-last [--apply]
//   node scripts/rollback-plan.mjs --repo DIR --mode redeploy-sha --sha SHA
//
// revert-last loads the previous release tree, then puts the current rollback
// tooling back. A text revert of the release commit conflicts once this branch
// edits deploy.yml, so this does not use git revert. --apply commits that tree
// locally. Without --apply it leaves the checkout unchanged. The commit subject
// is "Restore rel-...". This script never pushes.
//
// redeploy-sha resolves an earlier commit on this branch to its release id.
// It does not check out or deploy. The workflow does that only when dry_run is false.
//
// Prints one JSON object on stdout. Exit 0 ok, 1 refused, 2 usage.

import { spawnSync } from "node:child_process";
import { git, listReleaseCommits, RESTORE_SUBJECT, releaseForCommit, releaseForTree, restoreIsHonest, TOOLING_PATHS } from "./release-id.mjs";

const BOT = ["-c", "user.name=SpecDLC Rollback", "-c", "user.email=rollback@users.noreply.specdlc.com"];
const BOT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "SpecDLC Rollback",
  GIT_AUTHOR_EMAIL: "rollback@users.noreply.specdlc.com",
  GIT_COMMITTER_NAME: "SpecDLC Rollback",
  GIT_COMMITTER_EMAIL: "rollback@users.noreply.specdlc.com",
};

function die(code, msg) {
  console.error(`rollback: ${msg}`);
  process.exit(code);
}

function run(repo, args) {
  return spawnSync("git", args, { cwd: repo, encoding: "utf8", env: BOT_ENV });
}

function resetHard(repo, sha) {
  const result = run(repo, ["reset", "--hard", sha]);
  if (result.status !== 0) die(1, "could not restore the checkout after a refused revert");
}

function isAncestor(repo, ancestor, descendant) {
  if (ancestor === descendant) return false;
  return run(repo, ["merge-base", "--is-ancestor", ancestor, descendant]).status === 0;
}

// The published release is the one whose tree is HEAD. After extra commits,
// it is the release that no other release descends from. Commit dates can tie,
// so git log order is not the rule.
function latestRelease(repo) {
  const commits = listReleaseCommits(repo, "HEAD");
  if (!commits.length) return null;
  const subject = git(repo, ["log", "-1", "--format=%s", "HEAD"]);
  const restore = RESTORE_SUBJECT.exec(subject);
  if (restore && restoreIsHonest(repo, "HEAD", restore[1])) {
    return commits.find((commit) => commit.release_id === restore[1]) ?? null;
  }
  const headTree = git(repo, ["rev-parse", "HEAD^{tree}"]);
  const published = commits.find((commit) => git(repo, ["rev-parse", `${commit.sha}^{tree}`]) === headTree);
  if (published) return published;
  const maximal = commits.filter((commit) => !commits.some((other) => isAncestor(repo, commit.sha, other.sha)));
  return maximal.length === 1 ? maximal[0] : null;
}

function keepTooling(repo, base) {
  for (const path of TOOLING_PATHS) {
    if (run(repo, ["cat-file", "-e", `${base}:${path}`]).status !== 0) continue;
    if (run(repo, ["checkout", base, "--", path]).status !== 0) die(1, `could not keep ${path}`);
  }
}

const args = process.argv.slice(2);
let repo = ".";
let mode = "";
let sha = "";
let apply = false;
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  const value = () => {
    const next = args[++i];
    if (next === undefined) die(2, `missing value for ${flag}`);
    return next;
  };
  if (flag === "--repo") repo = value();
  else if (flag === "--mode") mode = value();
  else if (flag === "--sha") sha = value();
  else if (flag === "--apply") apply = true;
  else if (flag === "-h" || flag === "--help") {
    console.log("usage: node scripts/rollback-plan.mjs --repo DIR --mode revert-last|redeploy-sha [--sha SHA] [--apply]");
    process.exit(0);
  } else die(2, `unknown argument ${flag}`);
}

if (mode !== "revert-last" && mode !== "redeploy-sha") die(2, "--mode must be revert-last or redeploy-sha");
if (mode === "redeploy-sha" && apply) die(2, "--apply is only for revert-last; a sha redeploy is done by the workflow");

let base;
try {
  base = git(repo, ["rev-parse", "HEAD"]);
} catch {
  die(2, `not a git checkout: ${repo}`);
}

if (mode === "redeploy-sha") {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) die(2, "--sha must be a hex commit");
  let full;
  try {
    full = git(repo, ["rev-parse", "--verify", `${sha}^{commit}`]);
  } catch {
    die(1, "sha not found");
  }
  if (full === base) die(1, "sha is the current tip; pass an earlier commit");
  if (run(repo, ["merge-base", "--is-ancestor", full, "HEAD"]).status !== 0) {
    die(1, "sha is not an earlier commit on this branch");
  }
  const found = releaseForCommit(repo, full);
  if (!found) die(1, "sha has no release id");
  console.log(JSON.stringify({
    mode,
    dry_run: true,
    base_sha: base,
    revert_sha: "",
    target_sha: full,
    expected_release_id: found.release_id,
    expected_tree: found.tree,
    would_restore: true,
  }) + "\n");
  process.exit(0);
}

const latest = latestRelease(repo);
if (!latest) die(1, "no single latest release commit on HEAD");
let parent;
try {
  parent = git(repo, ["rev-parse", `${latest.sha}^`]);
} catch {
  die(1, "latest release commit has no parent");
}
const expectedTree = git(repo, ["rev-parse", `${parent}^{tree}`]);
const restored = releaseForTree(repo, expectedTree, "HEAD");
if (!restored || restored.sha === latest.sha) {
  die(1, "reverting the last release would not land on an earlier release");
}

if (git(repo, ["status", "--porcelain"])) die(1, "checkout is dirty");

if (run(repo, ["read-tree", "--reset", "-u", restored.sha]).status !== 0) {
  resetHard(repo, base);
  die(1, "could not load the previous release");
}
keepTooling(repo, base);
const extra = git(repo, ["diff", "--cached", "--name-only", restored.sha]).split("\n").filter(Boolean);
if (extra.some((path) => !TOOLING_PATHS.includes(path))) {
  resetHard(repo, base);
  die(1, "restore would change more than the rollback tooling");
}

const plan = {
  mode,
  dry_run: !apply,
  base_sha: base,
  revert_sha: latest.sha,
  target_sha: restored.sha,
  expected_release_id: restored.release_id,
  expected_tree: expectedTree,
  would_restore: true,
};

if (!apply) {
  resetHard(repo, base);
  console.log(JSON.stringify(plan) + "\n");
  process.exit(0);
}

const committed = run(repo, [...BOT, "commit", "-m", `Restore ${restored.release_id}`, "-m", `Restores ${restored.sha}.\n\nKeeps the rollback tooling from ${base} so deploy can publish release.json.`]);
if (committed.status !== 0) {
  resetHard(repo, base);
  die(1, "could not commit the restore");
}
plan.result_sha = git(repo, ["rev-parse", "HEAD"]);
console.log(JSON.stringify(plan) + "\n");
