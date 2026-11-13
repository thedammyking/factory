// parallel.test.mjs — two tickets of one run, and two runs, at once: run-state.mjs and run-stage.mjs spawned as processes
// running together on a throwaway project, with a fake `claude` on PATH in place of each implementer child.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { project, sh } from "./harness.mjs";

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugin/scripts");
const git = (cwd, ...args) => sh(cwd, "git", args);
const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const lines = (file) => fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [];

// The fake implementer child: it appends { argv, pid } to calls.jsonl in its dir, commits the files files.json gives its
// worktree, by the worktree's name, then writes a DONE report.
const FAKE = `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path"), { execFileSync } = require("node:child_process");
const dir = process.env.FAKE_CLAUDE, stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ argv: process.argv.slice(2), pid: process.pid }) + "\\n");
const files = JSON.parse(fs.readFileSync(path.join(dir, "files.json"), "utf8"))[path.basename(process.cwd())];
for (const [f, text] of Object.entries(files)) fs.writeFileSync(f, text);
execFileSync("git", ["add", "--", ...Object.keys(files)]);
execFileSync("git", ["commit", "-qm", "Implement the ticket"]);
fs.writeFileSync(stdin.match(/^implementation: (.+)$/m)[1], "status: DONE\\nconcerns:\\n- none\\n");
`;

// A project whose recipe's one check is `check`, and the scripts run as the orchestrator runs them, from the main
// checkout with the fake claude first on PATH: node() waits for one, start() runs one alongside others. Every fake child
// still alive is killed after the test, pass or fail.
function setup(t, check = "true") {
  const p = project({ recipe: { apps: [{ name: "app", type: "backend", path: ".", checks: { test: check } }] } });
  const bin = tmp("factory-bin-"), fake = tmp("factory-claude-"), files = {};
  fs.writeFileSync(path.join(bin, "claude"), FAKE, { mode: 0o755 });
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, FAKE_CLAUDE: fake, CLAUDE_CONFIG_DIR: tmp("factory-config-") };
  delete env.CLAUDE_CODE_SESSION_ID;
  const calls = () => lines(path.join(fake, "calls.jsonl")).map((l) => JSON.parse(l));
  t.after(() => { for (const { pid } of calls()) try { process.kill(pid, "SIGKILL"); } catch {} });
  const node = (script, args, input = "", timeout = 120_000) => spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { cwd: p.dir, input, env, encoding: "utf8", timeout });
  const start = (script, args, input = "") => new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(SCRIPTS, script), ...args], { cwd: p.dir, env, timeout: 120_000 });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => { stdout += d; }); c.stderr.on("data", (d) => { stderr += d; });
    c.on("close", (status) => resolve({ status, stdout, stderr }));
    c.stdin.end(input);
  });
  const commits = (worktree, changes) => { Object.assign(files, { [path.basename(worktree)]: changes }); fs.writeFileSync(path.join(fake, "files.json"), JSON.stringify(files)); };
  return { p, node, start, commits, calls };
}

// Another process's `git worktree add`, caught after making its admin dir's commondir and before filling it: the moment
// git's worktree and branch commands fail (docs/platform-facts.md, fact 14). stuck() leaves it there and returns the
// dir; adding() has it gone `ms` after it was made, well inside lib's second of retries, when the promise resolves.
function stuck(p) {
  const admin = path.join(p.dir, ".git", "worktrees", "other");
  fs.mkdirSync(admin, { recursive: true });
  fs.writeFileSync(path.join(admin, "gitdir"), path.join(p.dir, "other", ".git") + "\n");
  fs.writeFileSync(path.join(admin, "commondir"), "");
  return admin;
}
function adding(t, p, ms) {
  const admin = stuck(p), at = Date.now() + ms;
  const c = spawn(process.execPath, ["-e", `setTimeout(() => require("node:fs").rmSync(${JSON.stringify(admin)}, { recursive: true, force: true }), ${at} - Date.now())`], { stdio: "ignore" });
  t.after(() => c.kill("SIGKILL"));
  return new Promise((resolve) => c.on("close", resolve));
}

// Build run `s` (as init printed it) past done tickets, with each of `tickets` (NN -> the files its child commits,
// which its plan's code map lists, unless `map` names others) in progress and planned.
function planned(x, s, tickets, map = {}) {
  const run = (...args) => { const r = x.node("run-state.mjs", [...args, "--run", s.id]); assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}${r.stdout}`); return r; };
  triaged(x, s);
  run("lane");
  for (const [stage, file] of [["research", "research.md"], ["spec", "spec.md"], ["builder-check", "builder-check.md"]]) {
    run("dispatch", stage); fs.writeFileSync(path.join(s.run_dir, file), `# ${stage}\n`); run("done", stage);
  }
  run("approve", "spec", "approved");
  run("dispatch", "tickets");
  fs.mkdirSync(path.join(s.run_dir, "tickets"));
  for (const n of Object.keys(tickets)) fs.writeFileSync(path.join(s.run_dir, "tickets", `${n}-part.md`), `# ${n}: part\n\nStatus: ready-for-agent\nBlocked by: none\n`);
  run("done", "tickets");
  for (const [n, files] of Object.entries(tickets)) {
    run("ticket", n, "in-progress");
    run("dispatch", `plan:${n}`);
    fs.mkdirSync(path.join(s.run_dir, "tickets", n));
    fs.writeFileSync(path.join(s.run_dir, "tickets", n, "plan.md"), `---\nstatus: ready\nticket: ${n}-part\n---\n\n# Plan ${n}: part\n\n## Code map\n`
      + (map[n] || Object.keys(files)).map((f) => `- \`${f}\` (create): the part\n`).join(""));
    run("done", `plan:${n}`);
    x.commits(path.join(x.p.dir, ".factory/worktrees", `${s.id}-${n}`), files);
  }
  const stage = (word, n) => x.start("run-stage.mjs", [word, n, "--run", s.id]);
  const state = () => JSON.parse(run("get").stdout);
  return { ...s, run, stage, state, wt: (n) => path.join(x.p.dir, ".factory/worktrees", `${s.id}-${n}`), branch: (n) => `factory/${s.id}/${n}` };
}
// Every run here is triaged to build on the lane feature/export.
const triaged = (x, s) => {
  fs.writeFileSync(path.join(s.run_dir, "triage.md"), "```json\n" + JSON.stringify({ type: "feature", in_production: false, branch: "feature/export" }) + "\n```\n");
  assert.equal(x.node("run-state.mjs", ["set", "route", "build", "--run", s.id]).status, 0);
};
const init = (x, request) => { const r = x.node("run-state.mjs", ["init"], `${request}\n`); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
const last = (r) => { assert.equal(r.status, 0, r.stderr + r.stdout); return r.stdout.trim().split("\n").at(-1); };

test("run-state commands from tickets running at once never lose each other's writes, and a child or agent attaches to its own stage's dispatch", async (t) => {
  const x = setup(t);
  const r = planned(x, init(x, "Add a CSV export"), { "01": { "csv.js": "1\n" }, "02": { "pdf.js": "1\n" } });
  const done = await Promise.all(Array.from({ length: 12 }, (_, i) => x.start("run-state.mjs", ["done", `check:${i}`, "--run", r.id])));
  assert.deepEqual(done.map((d) => d.status), Array(12).fill(0), done.map((d) => d.stderr).join(""));
  const kept = r.state().stages_done;
  assert.deepEqual(Array.from({ length: 12 }, (_, i) => kept.includes(`check:${i}`)), Array(12).fill(true), "every one of the twelve is recorded");

  const before = r.state().dispatches.length, log = path.join(r.run_dir, "logs", "implement-01.1.jsonl");
  r.run("dispatch", "implement:01");
  r.run("dispatch", "context:02");
  r.run("dispatch", "implement:01", "--log", log, "--pid", "4242", "--session", "s-01");
  r.run("dispatch", "context:02", "--agent", "a-02");
  assert.deepEqual(r.state().dispatches.slice(before).map((d) => [d.stage, d.log, d.pid, d.session, d.agent]),
    [["implement:01", log, 4242, "s-01", undefined], ["context:02", undefined, undefined, undefined, "a-02"]], "two dispatches, each with its own");
});

test("reconcile, which holds the run's lock, prints the two started tickets' frontier from its own process", (t) => {
  const x = setup(t);
  const r = planned(x, init(x, "Add a CSV export"), { "01": { "csv.js": "1\n" }, "02": { "pdf.js": "2\n" } });
  const out = x.node("run-state.mjs", ["reconcile", "--run", r.id], "", 30_000);
  assert.equal(out.status, 0, `a run-state child waiting on the lock hangs it: ${out.stderr}`);
  assert.match(out.stdout, /^done: research spec builder-check tickets plan:01 plan:02\n/m);
  assert.match(out.stdout, /^STARTED 01-part\nSTARTED 02-part\n$/m);
});

test("two runs make their worktrees, their lanes, and their tickets' worktrees and branches, all at once, while another git process is adding a worktree", async (t) => {
  const x = setup(t);
  let busy = adding(t, x.p, 600);
  const inits = await Promise.all(["Add a CSV export", "Add a PDF export"].map((req) => x.start("run-state.mjs", ["init"], `${req}\n`)));
  assert.deepEqual(inits.map((r) => [r.status, r.stderr]), [[0, ""], [0, ""]]);
  await busy;
  const started = inits.map((r) => JSON.parse(r.stdout));
  for (const s of started) triaged(x, s);
  const lanes = await Promise.all(started.map((s) => x.start("run-state.mjs", ["lane", "--run", s.id])));
  assert.deepEqual(lanes.map((r) => r.status), [0, 0], lanes.map((r) => r.stderr).join(""));
  const [a, b] = started.map((s, i) => planned(x, s, { "01": { [`${i}-one.js`]: "1\n" }, "02": { [`${i}-two.js`]: "2\n" } }));
  const second = [a, b].find((r) => r.state().branch !== "feature/export");
  assert.deepEqual([a, b].map((r) => r.state().branch).sort(), ["feature/export", `feature/export-${second.id}`].sort(), "the run that lost the name gets its run id");

  busy = adding(t, x.p, 600);
  const runs = [a, b].flatMap((r) => ["01", "02"].map((n) => [r, n]));
  const implemented = await Promise.all(runs.map(([r, n]) => r.stage("implement", n)));
  await busy;
  for (const [i, [r, n]] of runs.entries()) {
    assert.match(last(implemented[i]), new RegExp(`^MERGE ${n}: DONE`), `${r.id} ${n}`);
    assert.equal(git(r.wt(n), "branch", "--show-current"), r.branch(n));
    assert.equal(git(r.wt(n), "rev-parse", "HEAD~1"), git(r.worktree, "rev-parse", "HEAD"), "the ticket's commit on the run head it was cut from");
  }

  const merged = await Promise.all(runs.map(([r, n]) => r.stage("merge", n)));
  for (const [i, [r, n]] of runs.entries()) {
    assert.match(last(merged[i]), new RegExp(`^MERGED ${n}: at \\w{7} on ${r.state().branch}, where verify --fast is green$`));
    assert.ok(!fs.existsSync(r.wt(n)), "the ticket's worktree is gone");
  }
  assert.equal(x.p.git("branch", "--list", "factory/*"), "", "and every ticket branch");
  assert.deepEqual([a, b].map((r) => git(r.worktree, "ls-files", "*.js").split("\n")), [["0-one.js", "0-two.js"], ["1-one.js", "1-two.js"]]);
  assert.deepEqual([a, b].map((r) => r.run("next-ticket").stdout.trim()), ["DONE", "DONE"]);
  assert.ok(x.calls().every(({ argv }) => argv.includes("--agent") && argv.includes("factory:implementer")), "four implementer children");
});

test("a ticket whose worktree can't be made leaves no branch behind, so its next attempt makes both", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root writes through a read-only dir");
  const x = setup(t);
  const r = planned(x, init(x, "Add a CSV export"), { "01": { "csv.js": "1\n" } });
  const dir = path.join(x.p.dir, ".factory/worktrees");
  fs.chmodSync(dir, 0o555);
  t.after(() => fs.chmodSync(dir, 0o755));
  assert.match(last(await r.stage("implement", "01")), /^ATTENTION 01: the ticket's worktree couldn't be made: /);
  assert.deepEqual([fs.existsSync(r.wt("01")), x.p.git("branch", "--list", r.branch("01"))], [false, ""]);
  fs.chmodSync(dir, 0o755);
  assert.match(last(await r.stage("implement", "01")), /^MERGE 01:/);
});

test("two ticket branches that finish together merge into the run branch one at a time, verify --fast running after each", async (t) => {
  const out = path.join(tmp("factory-checks-"), "checks.log");
  const x = setup(t, `echo "start $PWD" >> ${out} && sleep 0.4 && echo "end $PWD" >> ${out}`);
  const r = planned(x, init(x, "Add a CSV export"), { "01": { "csv.js": "1\n" }, "02": { "pdf.js": "2\n" } });
  for (const v of await Promise.all(["01", "02"].map((n) => r.stage("implement", n)))) assert.match(last(v), /^MERGE \d{2}:/);
  const merged = await Promise.all(["01", "02"].map((n) => r.stage("merge", n)));
  assert.deepEqual(merged.map((m) => last(m).split(":")[0]), ["MERGED 01", "MERGED 02"]);
  assert.deepEqual(lines(out).filter((l) => l.endsWith(` ${r.worktree}`)).map((l) => l.split(" ")[0]), ["start", "end", "start", "end"],
    "the second merge's verify starts after the first's ends");
  const head = git(r.worktree, "rev-parse", "HEAD"), e = JSON.parse(fs.readFileSync(path.join(r.run_dir, "evidence-fast.json"), "utf8"));
  assert.deepEqual([e.sha, e.green, git(r.worktree, "ls-files", "*.js")], [head, true, "csv.js\npdf.js"]);
});

test("a ticket whose branch conflicts with one merged before it is aborted for the human, two green tickets red together are the human's, and nothing merges into that red head", async (t) => {
  // The planner missed that both write shared.js, so their code maps let them run at once.
  const x = setup(t);
  const c = planned(x, init(x, "Add a CSV export"), { "01": { "shared.js": "1\n" }, "02": { "shared.js": "2\n" } }, { "01": ["csv.js"], "02": ["pdf.js"] });
  for (const v of await Promise.all(["01", "02"].map((n) => c.stage("implement", n)))) assert.match(last(v), /^MERGE \d{2}:/);
  assert.match(last(await c.stage("merge", "01")), /^MERGED 01:/);
  const head = git(c.worktree, "rev-parse", "HEAD");
  assert.equal(last(await c.stage("merge", "02")), `ATTENTION 02: merging ${c.branch("02")} into feature/export conflicts in shared.js, so the merge was aborted`);
  assert.deepEqual([git(c.worktree, "rev-parse", "HEAD"), git(c.worktree, "status", "--porcelain")], [head, ""], "the run head as the first merge left it");
  assert.ok(fs.existsSync(c.wt("02")) && x.p.git("branch", "--list", c.branch("02")), "the ticket's worktree and branch are kept");
  assert.equal(c.run("next-ticket").stdout.trim(), "STARTED 02-part", "and it isn't done");

  const y = setup(t, "test ! -f a.js || test ! -f b.js");  // each ticket green on its own, the two together red
  const r = planned(y, init(y, "Add a CSV export"), { "01": { "a.js": "1\n" }, "02": { "b.js": "2\n" }, "03": { "c.js": "3\n" } });
  for (const v of await Promise.all(["01", "02", "03"].map((n) => r.stage("implement", n)))) assert.match(last(v), /^MERGE \d{2}:/);
  assert.match(last(await r.stage("merge", "01")), /^MERGED 01:/);
  assert.match(last(await r.stage("merge", "02")), /^ATTENTION 02: verify --fast is red at the run head \w{7} after merging two green sides, red_cause introduced$/);
  const red = git(r.worktree, "rev-parse", "HEAD");
  assert.equal(last(await r.stage("merge", "03")), `ATTENTION 03: the run head is red at ${red.slice(0, 7)}, so ${r.branch("03")} isn't merged into it`);
  assert.equal(git(r.worktree, "rev-parse", "HEAD"), red);
});
