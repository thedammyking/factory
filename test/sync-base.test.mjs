// sync-base.test.mjs — sync-base.mjs spawned as a process on a run of a throwaway project whose origin is a local bare
// remote (a GitHub URL rewritten to it), with a fake `gh` on PATH that records each REST call.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { project, script, startRun, fakeClis, githubOrigin, sh, write } from "./harness.mjs";

// A run on a project whose origin is github.com/o/r.
function onGitHub() {
  const p = project(), bare = githubOrigin(p);
  const s = startRun(p);
  // the base moves on origin by a commit holding `files`
  const baseMoves = (files, message = "base moved") => { p.git("checkout", "-q", "main"); write(p.dir, files); p.git("add", "-A"); p.git("commit", "-qm", message); p.git("push", "-q", "origin", "main"); };
  return { p, s, bare, baseMoves };
}
const state = (s) => JSON.parse(fs.readFileSync(s.state ?? path.join(s.run_dir, "state.json"), "utf8"));
const sync = (s, mode, env) => script("sync-base.mjs", s.worktree, [mode, "--run", s.id], { env });
const noGh = () => fakeClis({ gh: [] });

test("before-review rebases the run's own commits onto origin's base and moves base_sha there; verify sees the new SHAs", () => {
  const { p, s, baseMoves } = onGitHub(), gh = noGh();
  s.commit({ "src/a.js": "export const a = 1;\n" }, "Add a");
  const mine = s.git("rev-parse", "HEAD");
  baseMoves({ "src/b.js": "export const b = 2;\n" });
  const tip = p.git("rev-parse", "main");
  const r = sync(s, "before-review", gh.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, new RegExp(`^rebased onto refs/remotes/origin/main at ${tip.slice(0, 7)}`, "m"));
  assert.equal(s.git("rev-parse", "HEAD^"), tip, "the run's commit sits on the base's tip");
  assert.notEqual(s.git("rev-parse", "HEAD"), mine, "every SHA changed");
  assert.equal(s.git("log", "-1", "--format=%s"), "Add a");
  assert.equal(state(s).base_sha, tip);
  assert.deepEqual(gh.calls("gh"), [], "a rebase makes no REST call");
  // nothing moved since: up to date, and still no REST call
  const again = sync(s, "before-review", gh.env);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /^up-to-date/m);
});

test("before-review replays only the run's commits, never a commit the local base holds that origin doesn't", () => {
  const { p, s } = onGitHub(), gh = noGh();
  // the run started from a local main holding a snapshot commit origin never got
  p.git("checkout", "-q", "main");
  write(p.dir, { ".factory/history/old/state.json": "{}\n" }); p.git("add", "-A"); p.git("commit", "-qm", "factory(run): old snapshot");
  s.git("reset", "-q", "--hard", "main");
  script("run-state.mjs", p.dir, ["set", "base_sha", JSON.stringify(p.git("rev-parse", "main")), "--run", s.id]);
  s.commit({ "src/a.js": "export const a = 1;\n" }, "Add a");
  const r = sync(s, "before-review", gh.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(s.git("rev-parse", "HEAD^"), p.git("rev-parse", "origin/main"));
  assert.equal(s.git("log", "--format=%s", "origin/main..HEAD"), "Add a");
});

test("fix 22: a before-review conflict aborts the rebase, leaves the branch as it was, writes attention-sync.md naming the files and ends the run needs-human", () => {
  const { s, baseMoves } = onGitHub(), gh = noGh();
  s.commit({ "src/a.js": "export const a = 1;\n", "src/b.js": "export const b = 1;\n" }, "Add a and b");
  const head = s.git("rev-parse", "HEAD"), base = state(s).base_sha;
  baseMoves({ "src/a.js": "export const a = 'theirs';\n", "src/b.js": "export const b = 'theirs';\n" });
  const r = sync(s, "before-review", gh.env);
  assert.equal(r.status, 1, r.stderr + r.stdout);
  const item = path.join(s.run_dir, "attention-sync.md");
  assert.equal(r.stdout.trim().split("\n").at(-1), `needs-human: ${item}`);
  const text = fs.readFileSync(item, "utf8");
  assert.match(text, /^# .*conflict/i);
  assert.match(text, /Run `.+`, stage `sync-base before-review`/);
  assert.match(text, /`src\/a\.js`.*`src\/b\.js`|src\/a\.js, src\/b\.js/s);
  assert.match(text, /## Options\n- `/);
  assert.equal(s.git("rev-parse", "HEAD"), head, "the branch is untouched");
  assert.equal(s.git("status", "--porcelain"), "", "no rebase is left in progress");
  assert.equal(fs.existsSync(sh(s.worktree, "git", ["rev-parse", "--git-path", "rebase-merge"])), false);
  assert.equal(state(s).stage, "needs-human");
  assert.equal(state(s).base_sha, base, "base_sha stays");
});

test("a before-review conflict in lockfiles alone goes through: each takes the base's side, then the recipe's setup regenerates it, committed (#81)", () => {
  const p = project({ recipe: { setup: "printf '{\\\"regenerated\\\":true}\\n' > package-lock.json", apps: [{ name: "app", type: "backend", path: ".", checks: { test: "true" } }] } });
  githubOrigin(p);
  const s = startRun(p), gh = noGh();
  s.commit({ "src/a.js": "export const a = 1;\n", "package-lock.json": "{\"mine\":true}\n" }, "Add a");
  p.git("checkout", "-q", "main"); write(p.dir, { "package-lock.json": "{\"theirs\":true}\n" }); p.git("add", "-A"); p.git("commit", "-qm", "base deps"); p.git("push", "-q", "origin", "main");
  const tip = p.git("rev-parse", "main");
  const r = sync(s, "before-review", gh.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /^lockfiles regenerated by `.+`: package-lock\.json$/m);
  assert.deepEqual(s.git("log", "--format=%s", `${tip}..HEAD`).split("\n"), ["chore: regenerate package-lock.json on main", "Add a"]);
  assert.equal(fs.readFileSync(path.join(s.worktree, "package-lock.json"), "utf8"), '{"regenerated":true}\n');
  assert.equal(fs.readFileSync(path.join(s.worktree, "src/a.js"), "utf8"), "export const a = 1;\n", "the run's own change stays");
  assert.equal(s.git("status", "--porcelain"), "");
  assert.equal(state(s).base_sha, tip);
});

test("before-review refuses once the PR is open: the branch is never rebased after its evidence is pinned", () => {
  const { s, baseMoves } = onGitHub(), gh = noGh();
  s.commit({ "src/a.js": "1\n" });
  baseMoves({ "src/b.js": "2\n" });
  write(s.run_dir, { "pr.json": JSON.stringify({ repo: "o/r", number: 7, head: "feature/signup" }) });
  const head = s.git("rev-parse", "HEAD");
  const r = sync(s, "before-review", gh.env);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /before-merge/);
  assert.equal(s.git("rev-parse", "HEAD"), head);
});

test("before-merge without pr.json merges the base in locally, keeping the run's commits, and makes no REST call", () => {
  const { p, s, baseMoves } = onGitHub(), gh = noGh();
  s.commit({ "src/a.js": "1\n" }, "Add a");
  const mine = s.git("rev-parse", "HEAD");
  baseMoves({ "src/b.js": "2\n" });
  const tip = p.git("rev-parse", "main");
  const r = sync(s, "before-merge", gh.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /^merged /m);
  assert.equal(s.git("rev-parse", "HEAD^1"), mine, "a merge, never a rebase: the run's commit keeps its SHA");
  assert.equal(s.git("rev-parse", "HEAD^2"), tip);
  assert.equal(state(s).base_sha, tip);
  assert.deepEqual(gh.calls("gh"), []);
});

test("fix 22: a local before-merge conflict names both files, aborts the merge and ends the run needs-human", () => {
  const { s, baseMoves } = onGitHub(), gh = noGh();
  s.commit({ "src/a.js": "mine\n", "src/b.js": "mine\n" });
  const head = s.git("rev-parse", "HEAD");
  baseMoves({ "src/a.js": "theirs\n", "src/b.js": "theirs\n" });
  const r = sync(s, "before-merge", gh.env);
  assert.equal(r.status, 1, r.stderr + r.stdout);
  const text = fs.readFileSync(path.join(s.run_dir, "attention-sync.md"), "utf8");
  assert.match(text, /stage `sync-base before-merge`/);
  assert.match(text, /src\/a\.js/); assert.match(text, /src\/b\.js/);
  assert.equal(s.git("rev-parse", "HEAD"), head);
  assert.equal(s.git("status", "--porcelain"), "");
  assert.equal(state(s).stage, "needs-human");
});

test("fix 22: with pr.json, before-merge asks GitHub to update the branch over REST, never `gh pr view`, then fast-forwards to its merge", () => {
  const { p, s, bare, baseMoves } = onGitHub();
  s.commit({ "src/a.js": "1\n" }, "Add a");
  s.git("push", "-q", "origin", "HEAD:refs/heads/feature/signup");
  const head = s.git("rev-parse", "HEAD");
  baseMoves({ "src/b.js": "2\n" });
  const tip = p.git("rev-parse", "main");
  // GitHub's side of a 202: the base merged into the PR's branch on the server
  const server = path.join(path.dirname(bare), `${path.basename(bare)}-clone`);
  sh(path.dirname(bare), "git", ["clone", "-q", "-b", "feature/signup", bare, server]);
  sh(server, "git", ["-c", "user.name=gh", "-c", "user.email=gh@gh", "merge", "-q", "--no-edit", "origin/main"]);
  sh(server, "git", ["push", "-q", "origin", "feature/signup"]);
  const merged = sh(server, "git", ["rev-parse", "HEAD"]);
  const accepted = path.join(s.run_dir, "..", "accepted.json");
  fs.writeFileSync(accepted, JSON.stringify({ message: "Updating pull request branch.", url: "https://github.com/o/r/pull/7" }));
  const gh = fakeClis({ gh: [{ match: /^api -X PUT repos\/o\/r\/pulls\/7\/update-branch/, file: accepted }] });
  write(s.run_dir, { "pr.json": JSON.stringify({ repo: "o/r", number: 7, head: "feature/signup" }) });
  const r = sync(s, "before-merge", gh.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(gh.calls("gh"), [["api", "-X", "PUT", "repos/o/r/pulls/7/update-branch", "-f", `expected_head_sha=${head}`]]);
  assert.equal(s.git("rev-parse", "HEAD"), merged, "the local branch fast-forwards to GitHub's merge");
  assert.equal(state(s).base_sha, tip);
  assert.match(r.stdout, /^merged .*update-branch/m);
});

test("fix 22: an update-branch GitHub refuses writes attention-sync.md quoting its message and ends the run needs-human", () => {
  const { s, baseMoves } = onGitHub();
  s.commit({ "src/a.js": "1\n" });
  baseMoves({ "src/b.js": "2\n" });
  const head = s.git("rev-parse", "HEAD");
  const refused = path.join(s.run_dir, "..", "refused.json");
  fs.writeFileSync(refused, JSON.stringify({ message: "merge conflict between base and head", documentation_url: "https://docs.github.com" }));
  const gh = fakeClis({ gh: [{ match: /update-branch/, file: refused, status: 1 }] });
  write(s.run_dir, { "pr.json": JSON.stringify({ repo: "o/r", number: 7, head: "feature/signup" }) });
  const r = sync(s, "before-merge", gh.env);
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.match(fs.readFileSync(path.join(s.run_dir, "attention-sync.md"), "utf8"), /merge conflict between base and head/);
  assert.equal(s.git("rev-parse", "HEAD"), head);
  assert.equal(state(s).stage, "needs-human");
  assert.ok(!gh.calls("gh").some((a) => a[0] === "pr"), "never gh pr");
});

test("before-merge with the base already in the branch is up to date and calls nothing, pr.json or not", () => {
  const { s } = onGitHub(), gh = noGh();
  s.commit({ "src/a.js": "1\n" });
  write(s.run_dir, { "pr.json": JSON.stringify({ repo: "o/r", number: 7, head: "feature/signup" }) });
  const r = sync(s, "before-merge", gh.env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^up-to-date/m);
  assert.deepEqual(gh.calls("gh"), []);
});
