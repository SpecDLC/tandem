import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLING_PATHS } from "../scripts/release-id.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OLD = "rel-20261021-3b5cb812";
const NEW = "rel-20261021-8951e9eb";
const MAIN = "001b6cc98deb88af6f50f38afa2e217e02d85cb3";

function g(repo, args) {
  return execFileSync("git", ["-c", "user.name=Rollback Test", "-c", "user.email=rollback-test@example.com", ...args], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
}

function runNode(script, args) {
  return execFileSync(process.execPath, [join(root, "scripts", script), ...args], { encoding: "utf8" });
}

function plan(repo, args) {
  try {
    return { code: 0, stdout: runNode("rollback-plan.mjs", ["--repo", repo, ...args]), stderr: "" };
  } catch (error) {
    return { code: error.status ?? 1, stdout: `${error.stdout ?? ""}`, stderr: `${error.stderr ?? ""}` };
  }
}

function releaseRepo() {
  const dir = mkdtempSync(join(tmpdir(), "rollback-"));
  g(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, "note.txt"), "base\n");
  g(dir, ["add", "note.txt"]);
  g(dir, ["commit", "-m", "base"]);
  writeFileSync(join(dir, "note.txt"), "old\n");
  g(dir, ["commit", "-am", `Release ${OLD}`]);
  const old = g(dir, ["rev-parse", "HEAD"]);
  g(dir, ["checkout", "-b", "release-next"]);
  writeFileSync(join(dir, "note.txt"), "new\n");
  g(dir, ["commit", "-am", `Release ${NEW}`]);
  const latest = g(dir, ["rev-parse", "HEAD"]);
  g(dir, ["checkout", "main"]);
  g(dir, ["merge", "--no-ff", "--no-edit", "release-next"]);
  return { dir, old, latest };
}

test("revert last restores the previous release and the check shows its id", () => {
  const { dir, old } = releaseRepo();
  try {
    const before = g(dir, ["rev-parse", "HEAD"]);
    const dry = plan(dir, ["--mode", "revert-last"]);
    assert.equal(dry.code, 0, dry.stderr);
    const dryPlan = JSON.parse(dry.stdout);
    assert.equal(dryPlan.dry_run, true);
    assert.equal(dryPlan.expected_release_id, OLD);
    assert.equal(dryPlan.target_sha, old);
    assert.equal(g(dir, ["rev-parse", "HEAD"]), before);
    assert.equal(g(dir, ["status", "--porcelain"]), "");
    const shown = runNode("live-version.mjs", ["--expect", dryPlan.expected_release_id, "--dry-run", "--url", "http://127.0.0.1:9"]);
    assert.match(shown, new RegExp(`live-version: ${OLD} \\(dry run, production not contacted\\)`));

    const applied = plan(dir, ["--mode", "revert-last", "--apply"]);
    assert.equal(applied.code, 0, applied.stderr);
    const body = JSON.parse(applied.stdout);
    assert.equal(body.dry_run, false);
    assert.equal(body.expected_release_id, OLD);
    assert.equal(g(dir, ["rev-parse", "HEAD^{tree}"]), body.expected_tree);
    assert.equal(readFileSync(join(dir, "note.txt"), "utf8"), "old\n");
    const releaseFile = join(dir, "release.json");
    assert.equal(runNode("release-id.mjs", ["--repo", dir, "--write", releaseFile]).trim(), OLD);
    assert.match(runNode("live-version.mjs", ["--expect", OLD, "--file", releaseFile]), new RegExp(`live-version: ${OLD}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a given sha resolves that release id and a non-ancestor is refused", () => {
  const { dir, old, latest } = releaseRepo();
  const other = mkdtempSync(join(tmpdir(), "rollback-other-"));
  try {
    const sha = plan(dir, ["--mode", "redeploy-sha", "--sha", old]);
    assert.equal(sha.code, 0, sha.stderr);
    const body = JSON.parse(sha.stdout);
    assert.equal(body.dry_run, true);
    assert.equal(body.target_sha, old);
    assert.equal(body.expected_release_id, OLD);
    assert.equal(g(dir, ["status", "--porcelain"]), "");
    const releaseFile = join(dir, "release.json");
    assert.equal(runNode("release-id.mjs", ["--repo", dir, "--commit", old, "--write", releaseFile]).trim(), OLD);
    assert.match(runNode("live-version.mjs", ["--expect", OLD, "--file", releaseFile]), new RegExp(`live-version: ${OLD}`));

    const current = plan(dir, ["--mode", "redeploy-sha", "--sha", latest]);
    assert.equal(current.code, 0, current.stderr);
    assert.equal(JSON.parse(current.stdout).expected_release_id, NEW);

    const tip = plan(dir, ["--mode", "redeploy-sha", "--sha", g(dir, ["rev-parse", "HEAD"])]);
    assert.equal(tip.code, 1);
    assert.match(tip.stderr, /current tip/);

    g(other, ["init", "-b", "main"]);
    writeFileSync(join(other, "note.txt"), "elsewhere\n");
    g(other, ["add", "note.txt"]);
    g(other, ["commit", "-m", `Release ${OLD}`]);
    const foreign = g(other, ["rev-parse", "HEAD"]);
    const refused = plan(dir, ["--mode", "redeploy-sha", "--sha", foreign]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /not found|not an earlier commit/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("revert last keeps tooling and replaces a later edit of the release", () => {
  const { dir } = releaseRepo();
  try {
    mkdirSync(join(dir, ".github/workflows"), { recursive: true });
    writeFileSync(join(dir, ".github/workflows/deploy.yml"), "scripts/live-version.mjs\n");
    writeFileSync(join(dir, "note.txt"), "later\n");
    g(dir, ["add", "-A"]);
    g(dir, ["commit", "-m", "later edit"]);
    const applied = plan(dir, ["--mode", "revert-last", "--apply"]);
    assert.equal(applied.code, 0, applied.stderr);
    const body = JSON.parse(applied.stdout);
    assert.equal(body.expected_release_id, OLD);
    assert.equal(readFileSync(join(dir, "note.txt"), "utf8"), "old\n");
    assert.equal(readFileSync(join(dir, ".github/workflows/deploy.yml"), "utf8"), "scripts/live-version.mjs\n");
    assert.equal(g(dir, ["log", "-1", "--format=%s"]), `Restore ${OLD}`);
    assert.equal(runNode("release-id.mjs", ["--repo", dir]).trim(), OLD);
    writeFileSync(join(dir, "note.txt"), "tamper\n");
    g(dir, ["commit", "-am", `Restore ${OLD}`]);
    let code = 0;
    try {
      runNode("release-id.mjs", ["--repo", dir]);
    } catch (error) {
      code = error.status ?? 1;
    }
    assert.equal(code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the workflow starts only by hand and a dry run cannot deploy", () => {
  const text = readFileSync(join(root, ".github/workflows/rollback.yml"), "utf8");
  const jobsAt = text.indexOf("\njobs:\n");
  const head = text.slice(0, jobsAt);
  assert.match(head, /^on:\n {2}workflow_dispatch:/m);
  for (const banned of ["push:", "pull_request:", "schedule:", "workflow_call:", "workflow_run:"]) {
    assert.equal(head.includes(banned), false, banned);
  }
  assert.match(head, /dry_run:[\s\S]*?default:\s*true/);
  const planPart = text.slice(text.indexOf("\n  plan:"), text.indexOf("\n  apply-revert:"));
  const revertPart = text.slice(text.indexOf("\n  apply-revert:"), text.indexOf("\n  apply-redeploy:"));
  const redeployPart = text.slice(text.indexOf("\n  apply-redeploy:"));
  assert.equal(planPart.includes("git push"), false);
  assert.equal(planPart.includes("wrangler"), false);
  assert.match(planPart, /--dry-run/);
  assert.match(revertPart, /inputs\.dry_run == false && inputs\.action == 'revert-last'/);
  assert.match(revertPart, /push origin HEAD:main/);
  assert.equal(revertPart.includes("wrangler"), false);
  assert.match(redeployPart, /inputs\.dry_run == false && inputs\.action == 'redeploy-sha'/);
  assert.match(redeployPart, /\$WRANGLER" deploy/);
  assert.match(redeployPart, /git worktree add --detach/);
  assert.equal(redeployPart.includes("git checkout --detach"), false);
  assert.match(redeployPart, /GITHUB_WORKSPACE\/scripts\/release-id\.mjs/);
  assert.match(redeployPart, /GITHUB_WORKSPACE\/scripts\/live-version\.mjs/);
  assert.equal(redeployPart.includes("git push"), false);
  const deploy = readFileSync(join(root, ".github/workflows/deploy.yml"), "utf8");
  assert.match(deploy, /scripts\/live-version\.mjs/);
  assert.match(deploy, /scripts\/release-id\.mjs/);
});

test("revert last on tandem main restores rel-20261021-3b5cb812", () => {
  try {
    execFileSync("git", ["cat-file", "-e", `${MAIN}^{commit}`], { cwd: root, stdio: "ignore" });
  } catch {
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "rollback-main-"));
  try {
    execFileSync("git", ["init", "-b", "main", dir], { stdio: "ignore" });
    execFileSync("git", ["-C", dir, "fetch", "--no-tags", root, `${MAIN}:refs/remotes/source/main`], { stdio: "pipe" });
    execFileSync("git", ["-C", dir, "checkout", "--detach", "refs/remotes/source/main"], { stdio: "ignore" });
    const dry = plan(dir, ["--mode", "revert-last"]);
    assert.equal(dry.code, 0, dry.stderr);
    const dryPlan = JSON.parse(dry.stdout);
    assert.equal(dryPlan.expected_release_id, OLD);
    assert.equal(dryPlan.dry_run, true);
    assert.equal(g(dir, ["rev-parse", "HEAD"]), MAIN);
    assert.equal(g(dir, ["status", "--porcelain"]), "");
    const sha = plan(dir, ["--mode", "redeploy-sha", "--sha", dryPlan.target_sha]);
    assert.equal(sha.code, 0, sha.stderr);
    assert.equal(JSON.parse(sha.stdout).expected_release_id, OLD);
    const releaseFile = join(tmpdir(), `release-${dryPlan.target_sha}.json`);
    assert.equal(runNode("release-id.mjs", ["--repo", dir, "--commit", dryPlan.target_sha, "--write", releaseFile]).trim(), OLD);
    assert.match(runNode("live-version.mjs", ["--expect", OLD, "--file", releaseFile]), new RegExp(`live-version: ${OLD}`));

    const applied = plan(dir, ["--mode", "revert-last", "--apply"]);
    assert.equal(applied.code, 0, applied.stderr);
    const body = JSON.parse(applied.stdout);
    assert.equal(body.expected_release_id, OLD);
    assert.equal(g(dir, ["log", "-1", "--format=%s"]), `Restore ${OLD}`);
    const names = g(dir, ["diff", "--name-only", body.target_sha, "HEAD"]).split("\n").filter(Boolean);
    for (const name of names) assert.ok(TOOLING_PATHS.includes(name), name);
    assert.equal(runNode("release-id.mjs", ["--repo", dir]).trim(), OLD);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("revert last on this pull request head keeps the new deploy workflow", () => {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const dir = mkdtempSync(join(tmpdir(), "rollback-head-"));
  try {
    execFileSync("git", ["init", "-b", "main", dir], { stdio: "ignore" });
    execFileSync("git", ["-C", dir, "fetch", "--no-tags", root, `${head}:refs/remotes/source/head`], { stdio: "pipe" });
    execFileSync("git", ["-C", dir, "checkout", "--detach", "refs/remotes/source/head"], { stdio: "ignore" });
    const dry = plan(dir, ["--mode", "revert-last"]);
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(JSON.parse(dry.stdout).expected_release_id, OLD);
    assert.equal(g(dir, ["rev-parse", "HEAD"]), head);
    assert.equal(g(dir, ["status", "--porcelain"]), "");
    const applied = plan(dir, ["--mode", "revert-last", "--apply"]);
    assert.equal(applied.code, 0, applied.stderr);
    const body = JSON.parse(applied.stdout);
    assert.equal(body.expected_release_id, OLD);
    assert.match(readFileSync(join(dir, ".github/workflows/deploy.yml"), "utf8"), /scripts\/live-version\.mjs/);
    const names = g(dir, ["diff", "--name-only", body.target_sha, "HEAD"]).split("\n").filter(Boolean);
    assert.ok(names.includes(".github/workflows/deploy.yml"));
    for (const name of names) assert.ok(TOOLING_PATHS.includes(name), name);
    assert.equal(runNode("release-id.mjs", ["--repo", dir]).trim(), OLD);
    assert.equal(g(dir, ["status", "--porcelain"]), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
