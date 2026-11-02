// run-state.test.mjs — `node --test drafts/scripts/`. Each test builds a throwaway git project with a stub recipe.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ATTR = JSON.stringify({ commit: "Co-Authored-By: Test <t@t>", pr: "" });

function project() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rs-")));
  const git = (...a) => { const r = spawnSync("git", a, { cwd: dir, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git("init", "-q", "-b", "develop"); git("config", "user.name", "t"); git("config", "user.email", "t@t");
  fs.mkdirSync(path.join(dir, ".factory"));
  fs.writeFileSync(path.join(dir, ".factory/setup.json"), JSON.stringify({ apps: [{ name: "app", path: ".", checks: { typecheck: "true", test: "true" } }] }));
  fs.writeFileSync(path.join(dir, ".factory/config.json"), "{}");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".factory/runs/\n");
  fs.writeFileSync(path.join(dir, "app.js"), "1\n");
  git("add", "."); git("commit", "-qm", "init");
  git("checkout", "-q", "-b", "feature/x");
  const node = (script, args, cwd = dir) => spawnSync(process.execPath, [path.join(HERE, script), ...args], { cwd, encoding: "utf8" });
  const rs = (...args) => node("run-state.mjs", args);
  const id = rs("init", "x", "do x", "--session", "s-1").stdout.trim();
  rs("set", "base_branch", "develop"); rs("set", "attribution", ATTR);
  return { dir, git, node, rs, id, run: path.join(dir, ".factory/runs", id) };
}

test("ACTIVE is JSON and tracks the branch", () => {
  const p = project();
  p.rs("set", "branch", "feature/x");
  const active = JSON.parse(fs.readFileSync(path.join(p.dir, ".factory/runs/ACTIVE"), "utf8"));
  assert.deepEqual([active.id, active.branch, active.session], [p.id, "feature/x", "s-1"]);
  assert.ok(active.started_at);
  const again = p.rs("init", "y", "other");
  assert.equal(again.status, 3); assert.match(again.stderr, /resume or abandon/);
});

test("a linked worktree finds the run in the main checkout", () => {
  const p = project();
  const wt = path.join(p.dir, "wt"); p.git("worktree", "add", "-q", "-b", "ticket-01", wt);
  assert.equal(p.node("lib.mjs", ["run-dir"], wt).stdout.trim(), p.run);
  assert.equal(p.node("run-state.mjs", ["get"], wt).status, 0);
});

test("snapshot moves a base that is checked out in another worktree, and repeats as a no-op", () => {
  const p = project();
  const live = path.join(os.tmpdir(), `rs-live-${process.pid}`); p.git("worktree", "add", "-q", live, "develop");
  const head = p.git("rev-parse", "HEAD");
  const r = p.rs("snapshot"); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /^snapshot \w+ on develop/);
  assert.ok(fs.existsSync(path.join(live, ".factory/history", p.id, "state.json")), "the live checkout was fast-forwarded");
  assert.equal(spawnSync("git", ["status", "--porcelain"], { cwd: live, encoding: "utf8" }).stdout, "");
  assert.equal(p.git("rev-parse", "HEAD"), head, "the feature branch never moves");
  assert.match(p.git("log", "-1", "--format=%B", "develop"), /Co-Authored-By: Test/);
  assert.match(p.rs("snapshot").stdout, /unchanged/);
  fs.rmSync(live, { recursive: true, force: true });
});

test("snapshot moves a base checked out nowhere, and refuses without attribution", () => {
  const p = project();
  const before = p.git("rev-parse", "develop");
  assert.equal(p.rs("snapshot").status, 0);
  assert.notEqual(p.git("rev-parse", "develop"), before);
  assert.equal(p.git("worktree", "list").split("\n").length, 1, "no worktree leaked");
  const state = JSON.parse(fs.readFileSync(path.join(p.run, "state.json"), "utf8")); delete state.attribution;
  fs.writeFileSync(path.join(p.run, "state.json"), JSON.stringify(state));
  const r = p.rs("snapshot"); assert.equal(r.status, 2); assert.match(r.stderr, /no commit attribution/);
});

test("retro-apply commits to a base checked out elsewhere", () => {
  const p = project();
  const live = path.join(os.tmpdir(), `rs-retro-${process.pid}`); p.git("worktree", "add", "-q", live, "develop");
  fs.writeFileSync(path.join(p.run, "retro.md"), "## 1. Lesson\n- kind: judgement call\n- target file: `.factory/lessons.md`\n- exact line:\n  `Check the thing (run x)`\n");
  const r = p.node("retro-apply.mjs", ["--all"]); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /applied=1/);
  assert.match(fs.readFileSync(path.join(live, ".factory/lessons.md"), "utf8"), /Check the thing/);
  assert.match(p.node("retro-apply.mjs", ["--all"]).stdout, /applied=0 skipped=1 commit=none/);
  fs.rmSync(live, { recursive: true, force: true });
});

test("next-ticket follows status and blocking edges; ticket rewrites the status", () => {
  const p = project();
  const t = path.join(p.run, "tickets"); fs.mkdirSync(t);
  fs.writeFileSync(path.join(t, "01-schema.md"), "# Schema\n**Status:** ready-for-agent\n**Blocked by:** none\n");
  fs.writeFileSync(path.join(t, "02-api.md"), "# API\n**Status:** ready-for-agent\n**Blocked by:** 01\n");
  fs.writeFileSync(path.join(t, "03-ui.md"), "# UI\n**Status:** ready-for-agent\n**Blocked by:** 01\n");
  assert.equal(p.rs("next-ticket").stdout.trim(), "NEXT 01-schema");
  p.rs("ticket", "01", "in-progress");
  assert.equal(p.rs("next-ticket").stdout.trim(), "NEXT 01-schema");
  p.rs("ticket", "01-schema", "built");
  assert.match(fs.readFileSync(path.join(t, "01-schema.md"), "utf8"), /^\*\*Status:\*\* built$/m);
  assert.equal(p.rs("next-ticket").stdout.trim(), "NEXT 02-api,03-ui");
  p.rs("ticket", "02", "blocked"); p.rs("ticket", "03", "in-review");
  const b = p.rs("next-ticket"); assert.equal(b.status, 5); assert.match(b.stdout, /^BLOCKED 02-api:blocked 03-ui:in-review/);
  p.rs("ticket", "02", "done"); p.rs("ticket", "03", "dropped");
  assert.equal(p.rs("next-ticket").stdout.trim(), "DONE");
});

test("reconcile salvages a dead implementer's work, never the recipe, and refunds an empty round", () => {
  const p = project();
  p.rs("round", "implement"); p.rs("dispatch", "implement:01"); p.rs("agent", "agent-7");
  // nothing committed since the dispatch: the round is refunded and the agent resumed
  let r = p.rs("reconcile"); assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /commits=0 salvaged=none action=resume agent-7 rounds\.implement=0/);
  assert.match(r.stdout, /VERIFY fast green=true/);
  // the next attempt leaves edits behind, product and recipe
  p.rs("round", "implement"); p.rs("dispatch", "implement:01");
  fs.writeFileSync(path.join(p.dir, "app.js"), "2\n"); fs.writeFileSync(path.join(p.dir, "new.js"), "3\n");
  fs.writeFileSync(path.join(p.dir, ".factory/setup.json"), "{}");
  r = p.rs("reconcile");
  assert.match(r.stdout, /commits=1 salvaged=\w{7} recipe=MODIFIED\(needs-human\) action=fresh rounds\.implement=1/);
  assert.match(p.git("log", "-1", "--format=%s"), /^wip\(factory\): salvaged from round 1/);
  assert.deepEqual(p.git("show", "--name-only", "--format=", "HEAD").split("\n").sort(), ["app.js", "new.js"]);
});

test("the 70% minutes warning fires once; a stale run is named as stale", () => {
  const p = project();
  const sp = path.join(p.run, "state.json");
  const age = (min) => { const s = JSON.parse(fs.readFileSync(sp, "utf8")); s.created_at = s.updated_at = new Date(Date.now() - min * 60000).toISOString(); fs.writeFileSync(sp, JSON.stringify(s)); };
  age(70);
  assert.match(p.rs("dispatch", "plan:01").stdout, /^WARN 70% of minutes budget/);
  assert.doesNotMatch(p.rs("dispatch", "implement:01").stdout, /WARN/);
  age(200);
  const r = p.rs("init", "y", "other"); assert.equal(r.status, 3); assert.match(r.stderr, /looks stale/);
});
