// run-state.test.mjs — run-state.mjs spawned as a process against a throwaway project.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { project, sh } from "./harness.mjs";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugin/scripts/run-state.mjs");
const TODAY = new Date().toISOString().slice(0, 10);
const git = (cwd, ...args) => sh(cwd, "git", args);
const ENV = { ...process.env, CLAUDE_CODE_SESSION_ID: "s-1" };
const rs = (cwd, args, input = "") => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, input, encoding: "utf8", env: ENV });
const rsAsync = (cwd, args, input) => new Promise((resolve) => {
  const child = spawn(process.execPath, [SCRIPT, ...args], { cwd, env: ENV });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  child.on("close", (status) => resolve({ status, stdout, stderr }));
  child.stdin.end(input);
});
const init = (p, request = "Add a CSV export to the reports page") => {
  const r = rs(p.dir, ["init"], request + "\n");
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test("init makes a run worktree detached at the base tip, holding the run dir, and records the session and request", () => {
  const p = project();
  const s = init(p);
  const wt = path.join(p.dir, ".factory/worktrees", `${TODAY}-add-a-csv-export`);
  assert.equal(s.id, `${TODAY}-add-a-csv-export`);
  assert.equal(s.run_dir, path.join(wt, ".factory/runs", s.id));
  assert.equal(git(wt, "rev-parse", "HEAD"), p.git("rev-parse", "main"));
  assert.equal(git(wt, "branch", "--show-current"), "", "detached");
  assert.deepEqual([s.session, s.request, s.base_branch, s.stage], ["s-1", "Add a CSV export to the reports page", "main", "start"]);
  assert.equal(fs.readFileSync(path.join(s.run_dir, "prompt.md"), "utf8"), "Add a CSV export to the reports page\n");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.run_dir, "state.json"), "utf8")), s);
  assert.equal(p.git("status", "--porcelain"), "", "the main checkout stays clean");
  assert.equal(git(wt, "status", "--porcelain"), "", "the run dir never dirties the run worktree");
});

test("no script guesses the run: get takes --run or derives it from the run worktree, and there is no ACTIVE file", () => {
  const p = project();
  const a = init(p), b = init(p, "Fix the login crash");
  assert.equal(JSON.parse(rs(p.dir, ["get", "--run", b.id]).stdout).request, "Fix the login crash");
  assert.equal(JSON.parse(rs(path.join(a.worktree, ".factory"), ["get"]).stdout).id, a.id, "derived from a subdirectory of the run worktree");
  const guess = rs(p.dir, ["get"]);
  assert.equal(guess.status, 2);
  assert.match(guess.stderr, /pass --run <id>/);
  assert.match(rs(p.dir, ["get", "--run", "2020-01-01-nope"]).stderr, /no run 2020-01-01-nope/);
  assert.equal(rs(p.dir, ["get", "--run", `../${a.id}`]).status, 2, "a run id is never a path");
  assert.deepEqual(fs.readdirSync(p.dir, { recursive: true }).filter((f) => path.basename(f) === "ACTIVE"), []);
});

test("set holds the route and outcome enums", () => {
  const p = project();
  const s = init(p);
  const set = (key, value) => rs(p.dir, ["set", key, value, "--run", s.id]);
  for (const route of ["oneshot", "build", "answer", "hold", "map"]) assert.equal(set("route", route).status, 0, route);
  const fix = set("route", "fix");
  assert.equal(fix.status, 2);
  assert.match(fix.stderr, /oneshot \| build \| answer \| hold \| map/);
  for (const outcome of ["delivered", "needs-human", "failed", "answered", "charted"]) assert.equal(set("stage", outcome).status, 0, outcome);
  assert.match(set("stage", "abandoned").stderr, /abandon/, "abandoning has its own command");
  assert.equal(set("stage", "merged").status, 2);
  assert.equal(set("stage", "triage").status, 2, "only dispatch sets a working stage");
  set("in_production", "false");
  const state = JSON.parse(rs(p.dir, ["get", "--run", s.id]).stdout);
  assert.deepEqual([state.route, state.stage, state.in_production], ["map", "charted", false]);
});

test("a run routed hold makes no lane branch", () => {
  const p = project();
  const s = init(p);
  assert.equal(rs(p.dir, ["set", "route", "hold", "--run", s.id]).status, 0);
  assert.equal(p.git("for-each-ref", "--format=%(refname)", "refs/heads"), "refs/heads/main");
  assert.equal(git(s.worktree, "branch", "--show-current"), "", "still detached");
});

test("dispatch records the stage, the run worktree's HEAD and the agent id; done marks the stage done", () => {
  const p = project();
  const s = init(p);
  p.git("commit", "-q", "--allow-empty", "-m", "the main checkout moves on");
  const run = (...args) => rs(p.dir, [...args, "--run", s.id]);
  const state = () => JSON.parse(run("get").stdout);
  assert.equal(run("dispatch", "triage").status, 0);
  assert.equal(run("dispatch", "triage", "--agent", "a-7").status, 0, "the id is known once the agent has started");
  assert.equal(run("done", "triage").status, 0);
  let st = state();
  assert.equal(st.stage, "triage");
  assert.equal(st.dispatches.length, 1);
  assert.deepEqual([st.dispatches[0].stage, st.dispatches[0].sha, st.dispatches[0].agent], ["triage", s.base_sha, "a-7"]);
  assert.deepEqual(st.stages_done, ["triage"]);
  fs.writeFileSync(path.join(s.run_dir, "triage.md"), "first triage\n");
  assert.equal(run("dispatch", "triage").status, 0, "a re-triage");
  st = state();
  assert.equal(st.dispatches.length, 2);
  assert.deepEqual(st.stages_done, [], "a stage dispatched again is no longer done");
  assert.ok(!fs.existsSync(path.join(s.run_dir, "triage.md")), "a dispatch with no output yet is working, so the old output goes");
  assert.equal(fs.readFileSync(path.join(s.run_dir, "triage.round1.md"), "utf8"), "first triage\n");
});

test("status lists two runs started at the same moment, one line each", async () => {
  const p = project();
  const started = await Promise.all([1, 2].map(() => rsAsync(p.dir, ["init"], "Fix the login crash\n")));
  for (const r of started) assert.equal(r.status, 0, r.stderr);
  const ids = started.map((r) => JSON.parse(r.stdout).id).sort();
  assert.deepEqual(ids, [`${TODAY}-fix-the-login-crash`, `${TODAY}-fix-the-login-crash-2`]);
  rs(p.dir, ["set", "route", "hold", "--run", ids[1]]);
  const lines = rs(p.dir, ["status"]).stdout.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines.find((l) => l.startsWith(`${ids[0]} `)), /^\S+\s+start\s+-\s+Fix the login crash$/);
  assert.match(lines.find((l) => l.startsWith(`${ids[1]} `)), /^\S+\s+start\s+hold\s+Fix the login crash$/);
});

test("abandon ends a run abandoned and keeps its branch and worktree; a finished run takes no more dispatches", () => {
  const p = project();
  const s = init(p), waiting = init(p, "Fix the login crash");
  git(s.worktree, "switch", "-q", "-c", "feature/csv-export");
  const r = rs(p.dir, ["abandon", "--run", s.id]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(rs(p.dir, ["get", "--run", s.id]).stdout).stage, "abandoned");
  assert.equal(git(s.worktree, "branch", "--show-current"), "feature/csv-export", "the branch and its worktree stay");
  assert.ok(fs.existsSync(path.join(s.run_dir, "prompt.md")));
  assert.equal(rs(p.dir, ["dispatch", "triage", "--run", s.id]).status, 2);
  assert.equal(rs(p.dir, ["abandon", "--run", s.id]).status, 2, "already abandoned");
  rs(p.dir, ["set", "stage", "needs-human", "--run", waiting.id]);
  assert.match(rs(p.dir, ["status"]).stdout, new RegExp(`^${waiting.id}\\s+needs-human\\s`), "a run waiting on the human is listed; an abandoned one isn't");
  assert.equal(rs(p.dir, ["abandon", "--run", waiting.id]).status, 0, "a run waiting on the human can be abandoned");
  assert.equal(rs(p.dir, ["status"]).stdout.trim(), "no active runs");
});

test("under git flow a run starts at develop's tip", () => {
  const p = project({ config: { branching: { model: "git-flow", main: "main", develop: "develop" } } });
  p.git("switch", "-q", "-c", "develop");
  p.git("commit", "-q", "--allow-empty", "-m", "develop moves ahead");
  p.git("switch", "-q", "main");
  const s = init(p);
  assert.equal(s.base_branch, "develop");
  assert.equal(git(s.worktree, "rev-parse", "HEAD"), p.git("rev-parse", "develop"));
  assert.notEqual(s.base_sha, p.git("rev-parse", "main"));
});
