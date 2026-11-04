// run-stage.test.mjs — run-stage.mjs and run-state.mjs round, spawned as processes, on one ticket of a build run on a
// throwaway project, with a fake `claude` on PATH in place of the implementer child.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { project, sh, write, STUB_SERVER } from "./harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = path.join(ROOT, "plugin"), SCRIPTS = path.join(PLUGIN, "scripts");
const git = (cwd, ...args) => sh(cwd, "git", args);
const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

// The fake implementer child. Each call appends { argv, stdin, cwd, pid, ls } to calls.jsonl in its dir and plays the
// next step of steps.json: it writes `files` into its cwd and commits them by name when the step has `commit`, writes
// `write` (absolute paths, such as implementation.md) as they are, prints a stream-json init and result line for its
// session (--session-id or --resume), the result listing each Bash command in `denied` as a permission denial, and exits
// `exit`. Between the two it prints each of `print` as a line of that session; a step with `hang` then marks `hanging` in
// its dir and waits until it's killed, printing no result.
const FAKE = `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path"), { execFileSync } = require("node:child_process");
const dir = process.env.FAKE_CLAUDE, argv = process.argv.slice(2), stdin = fs.readFileSync(0, "utf8");
const log = path.join(dir, "calls.jsonl"), n = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\\n").length : 0;
fs.appendFileSync(log, JSON.stringify({ argv, stdin, cwd: process.cwd(), pid: process.pid, ls: fs.readdirSync(".") }) + "\\n");
const step = JSON.parse(fs.readFileSync(path.join(dir, "steps.json"), "utf8"))[n] || {};
const at = (k) => argv[argv.indexOf(k) + 1], session = argv.includes("--resume") ? at("--resume") : at("--session-id");
for (const [f, text] of Object.entries(step.files || {})) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); }
if (step.commit) { execFileSync("git", ["add", "--", ...Object.keys(step.files)]); execFileSync("git", ["commit", "-qm", step.commit]); }
for (const [f, text] of Object.entries(step.write || {})) fs.writeFileSync(f, text);
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: session }));
for (const e of step.print || []) console.log(JSON.stringify({ session_id: session, ...e }));
if (step.hang) { fs.writeFileSync(path.join(dir, "hanging"), ""); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }
const permission_denials = (step.denied || []).map((command) => ({ tool_name: "Bash", tool_input: { command } }));
console.log(JSON.stringify({ type: "result", subtype: "success", session_id: session, permission_denials, modelUsage: { [at("--model")]: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0 } } }));
process.exitCode = step.exit || 0;
`;

// The recipe every ticket here builds against: its setup marks the worktree, and its test passes once csv.js exists.
const RECIPE = { setup: "echo installed > .deps", apps: [{ name: "app", type: "backend", path: ".", checks: { test: "npm test", typecheck: "CI=1 node --check index.js" } }] };
const PACKAGE = JSON.stringify({ name: "reports", scripts: { test: "test -f csv.js" } });

// A build run on a project holding `recipe`, past the ticket gate, with ticket 01 in progress and its plan ready. stage()
// runs run-stage.mjs as the orchestrator does, from the main checkout, with the fake claude first on PATH playing the
// steps play() sets. Every fake child still alive is killed after the test, pass or fail. `files` are committed with the
// product.
function ticketReady(t, { recipe = RECIPE, config = {}, files = {} } = {}) {
  const p = project({ recipe, config });
  fs.writeFileSync(path.join(p.dir, "package.json"), PACKAGE);
  fs.writeFileSync(path.join(p.dir, "index.js"), "1\n");
  write(p.dir, files);
  p.git("add", "."); p.git("commit", "-qm", "product");
  fs.appendFileSync(path.join(p.dir, ".git/info/exclude"), ".deps\n");
  const bin = tmp("factory-bin-"), fake = tmp("factory-claude-");
  fs.writeFileSync(path.join(bin, "claude"), FAKE, { mode: 0o755 });
  const play = (steps) => fs.writeFileSync(path.join(fake, "steps.json"), JSON.stringify(steps));
  play([]);
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, FAKE_CLAUDE: fake, CLAUDE_CONFIG_DIR: tmp("factory-config-") };
  delete env.CLAUDE_CODE_SESSION_ID;
  const node = (script, args, input = "") => spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { cwd: p.dir, input, env, encoding: "utf8", timeout: 120_000 });
  const s = JSON.parse(node("run-state.mjs", ["init"], "Add a CSV export\n").stdout);
  const run = (...args) => { const r = node("run-state.mjs", [...args, "--run", s.id]); assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}${r.stdout}`); return r; };
  fs.writeFileSync(path.join(s.run_dir, "triage.md"), "```json\n" + JSON.stringify({ type: "feature", in_production: false, branch: "feature/csv-export" }) + "\n```\n");
  run("set", "route", "build");
  run("lane");
  for (const [stage, file] of [["research", "research.md"], ["spec", "spec.md"], ["builder-check", "builder-check.md"]]) {
    run("dispatch", stage); fs.writeFileSync(path.join(s.run_dir, file), `# ${stage}\n`); run("done", stage);
  }
  run("approve", "spec", "approved");
  run("dispatch", "tickets");
  fs.mkdirSync(path.join(s.run_dir, "tickets", "01"), { recursive: true });
  fs.writeFileSync(path.join(s.run_dir, "tickets", "01-csv-export.md"), "# 01: CSV export\n\nStatus: ready-for-agent\nBlocked by: none\n");
  run("done", "tickets");
  run("approve", "tickets", "approved");
  run("ticket", "01", "in-progress");
  run("dispatch", "plan:01");
  fs.writeFileSync(path.join(s.run_dir, "tickets", "01", "plan.md"), "---\nstatus: ready\nticket: 01-csv-export\n---\n\n# Plan 01: CSV export\n");
  run("done", "plan:01");
  const calls = () => { const f = path.join(fake, "calls.jsonl"); return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []; };
  t.after(() => { for (const { pid } of calls()) try { process.kill(pid, "SIGKILL"); } catch {} });
  const stage = (...args) => node("run-stage.mjs", [...args, "--run", s.id]);
  const state = () => JSON.parse(run("get").stdout);
  const wt = path.join(p.dir, ".factory/worktrees", `${s.id}-01`), tickets = path.join(s.run_dir, "tickets", "01");
  return { p, s, run, stage, state, calls, play, wt, tickets, impl: path.join(tickets, "implementation.md"), branch: `factory/${s.id}/01`, node, env, fake };
}
const flag = (argv, name) => argv[argv.indexOf(name) + 1];
const lastLine = (r) => { assert.equal(r.status, 0, r.stderr + r.stdout); return r.stdout.trim().split("\n").at(-1); };
// implementation.md as the implementer finishes it, with `status` and `concerns` lines (and `more` before assumptions:)
const report = (status, { cause = "none", concerns = "- none", more = "" } = {}) => "# Implementation 01\n\n- abc1234 Add the CSV export: the ticket's one outcome\n\n"
  + `status: ${status}\nblocked_cause: ${cause}\n${more}assumptions:\n- none\nconcerns:\n${concerns}\ndenied:\n- none\n`
  + "assessment:\n  recommendation: merge\n  confident: true\n  reason: its tests pass.\n";
const CSV = { files: { "csv.js": "export const csv = 1;\n" }, commit: "Add the CSV export" };
const branches = (r) => r.p.git("branch", "--list", r.branch);

test("implement cuts the ticket's worktree on factory/<run>/NN at the SHA its dispatch records, runs the recipe's setup there, and starts the implementer child with its flags", (t) => {
  const r = ticketReady(t);
  r.play([CSV]);
  const head = git(r.s.worktree, "rev-parse", "HEAD");
  const out = r.stage("implement", "01");
  assert.equal(out.status, 0, out.stderr + out.stdout);
  const d = r.state().dispatches.at(-1);
  assert.deepEqual([d.stage, d.sha], ["implement:01", head], "the dispatch records the run head the ticket is cut from");
  assert.equal(git(r.wt, "branch", "--show-current"), r.branch);
  assert.equal(git(r.wt, "rev-parse", "HEAD~1"), head, "the child's commit sits on the recorded SHA");
  const [call] = r.calls();
  assert.equal(call.cwd, r.wt, "the child works in the ticket's worktree");
  assert.ok(call.ls.includes(".deps"), "the recipe's setup ran before the child started");
  const { argv } = call;
  assert.ok(argv.includes("-p") && argv.includes("--strict-mcp-config") && argv.includes("--verbose"));
  assert.ok(!argv.includes("--mcp-config") && !argv.includes("--resume"));
  assert.deepEqual(["--agent", "--plugin-dir", "--model", "--max-turns", "--permission-mode", "--permission-prompts", "--add-dir", "--output-format"].map((k) => flag(argv, k)),
    ["factory:implementer", PLUGIN, "sonnet", "150", "acceptEdits", "none", r.s.run_dir, "stream-json"]);
  const gitRules = ["status", "diff", "log", "show", "add", "rm", "mv", "restore", "commit"].map((c) => `Bash(git ${c}:*)`);
  assert.deepEqual(flag(argv, "--allowedTools").split(","), ["Bash(npm:*)", "Bash(node:*)", ...gitRules, "Bash(npm ci:*)", "Bash(npm install:*)", `Bash(node ${SCRIPTS}/verify.mjs:*)`, "Skill(factory:ui-craft)"],
    "each check's executable, git with no push, fetch or rebase, the package manager's install and add, verify, and the craft floor");
  assert.match(flag(argv, "--session-id"), /^[0-9a-f-]{36}$/);
  assert.deepEqual([d.pid, d.session], [call.pid, flag(argv, "--session-id")], "the dispatch records the child's PID and session id");
  assert.ok(d.log.startsWith(path.join(r.s.run_dir, "logs") + path.sep));
  assert.match(fs.readFileSync(d.log, "utf8"), /"subtype":"init"/, "and the stream-json log it writes");
  for (const line of [`run_dir: ${r.s.run_dir}`, `worktree: ${r.wt}`, "ticket: 01-csv-export", `plan: ${path.join(r.tickets, "plan.md")}`, `implementation: ${r.impl}`]) {
    assert.ok(call.stdin.split("\n").includes(line), line);
  }
});

test("a crossed cap passes run-state's BUDGET refusal through before any worktree or child, and a setup that fails takes its new worktree away again", (t) => {
  const capped = ticketReady(t, { config: { caps: { dispatches_per_run: 5 } } });
  const refused = capped.stage("implement", "01");
  assert.equal(refused.status, 4);
  assert.match(refused.stdout, /^BUDGET dispatches 5\/5: implement:01 not dispatched$/m);
  assert.deepEqual([fs.existsSync(capped.wt), capped.calls()], [false, []]);

  const failing = ticketReady(t, { recipe: { ...RECIPE, setup: "echo 'npm ERR! missing lockfile'; exit 1" } });
  const out = failing.stage("implement", "01");
  assert.equal(lastLine(out), "ATTENTION 01: the recipe's setup failed in the ticket's worktree");
  assert.match(out.stdout, /npm ERR! missing lockfile\nfull output: .*setup-01\.log/);
  assert.deepEqual([fs.existsSync(failing.wt), branches(failing), failing.calls()], [false, "", []], "the next attempt cuts it again");
});

test("verify --full judges the ticket's own worktree and keeps its evidence beside the plan, and a DONE report with green evidence there is MERGE", (t) => {
  const recipe = { ...RECIPE, apps: [{ ...RECIPE.apps[0], checks: { ...RECIPE.apps[0].checks, where: "pwd" } }] };
  const r = ticketReady(t, { recipe });
  r.play([{ ...CSV, write: { [r.impl]: report("DONE") } }]);
  const out = r.stage("implement", "01");
  const sha = git(r.wt, "rev-parse", "HEAD");
  assert.equal(lastLine(out), `MERGE 01: DONE, and verify --full is green at ${sha.slice(0, 7)}`);
  const e = JSON.parse(fs.readFileSync(path.join(r.tickets, "evidence.json"), "utf8"));
  assert.deepEqual([e.mode, e.sha, e.green], ["full", sha, true]);
  const where = e.checks.find((c) => c.check === "where");
  assert.equal(where.log, path.join(r.tickets, "logs", "app-where.log"));
  assert.equal(fs.readFileSync(where.log, "utf8"), r.wt + "\n", "the checks ran in the ticket's worktree");
  assert.ok(!fs.existsSync(path.join(r.s.run_dir, "evidence.json")), "the run head's evidence is the merge's");
  assert.ok(r.state().stages_done.includes("implement:01"), "a report with a status line is a done stage");
});

test("a report with no status line, a named concern and a red the ticket introduced each go round again; a red the base had too is the human's", (t) => {
  for (const [why, step, verdict] of [
    ["no status line", (r) => ({ ...CSV, write: { [r.impl]: "# Implementation 01\n\n- abc1234 Add the CSV export: half of it\n" } }), /^ROUND 01: implementation\.md has no status line, so the attempt is INCOMPLETE$/],
    ["a concern", (r) => ({ ...CSV, write: { [r.impl]: report("DONE", { concerns: "- an account name holding a comma breaks the row" }) } }), /^ROUND 01: the implementer named a concern/],
    ["introduced", (r) => ({ files: { "csv.js": "1\n", "index.js": "syntax error (\n" }, commit: "Break the index", write: { [r.impl]: report("DONE") } }), /^ROUND 01: verify --full is red at \w{7}, red_cause introduced$/],
    ["inherited", (r) => ({ files: { "notes.txt": "1\n" }, commit: "No export yet", write: { [r.impl]: report("DONE") } }), /^ATTENTION 01: verify --full is red at \w{7}, red_cause inherited$/],
  ]) {
    const r = ticketReady(t);
    r.play([step(r)]);
    assert.match(lastLine(r.stage("implement", "01")), verdict, why);
    assert.equal(r.state().stages_done.includes("implement:01"), why !== "no status line", why);
  }
});

// A ticket implemented to MERGE, its child having committed csv.js.
function green(t) {
  const r = ticketReady(t);
  r.play([{ ...CSV, write: { [r.impl]: report("DONE") } }]);
  assert.match(lastLine(r.stage("implement", "01")), /^MERGE 01:/);
  return r;
}

test("merge takes only a MERGE ticket into the run branch, runs verify --full at the new head, removes the ticket's worktree and branch, and marks it done", (t) => {
  const early = ticketReady(t);
  const refused = early.stage("merge", "01");
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /ticket 01 isn't ready to merge/);

  const r = green(t);
  const ticketHead = git(r.wt, "rev-parse", "HEAD");
  const out = r.stage("merge", "01");
  const head = git(r.s.worktree, "rev-parse", "HEAD");
  assert.equal(lastLine(out), `MERGED 01: at ${head.slice(0, 7)} on feature/csv-export, where verify --full is green`);
  assert.equal(head, ticketHead, "the ticket's commits are on the run branch");
  const e = JSON.parse(fs.readFileSync(path.join(r.s.run_dir, "evidence.json"), "utf8"));
  assert.deepEqual([e.sha, e.green], [head, true], "the run head's own evidence");
  assert.ok(!fs.existsSync(r.wt), "the ticket's worktree is gone");
  assert.equal(branches(r), "", "and so is its branch");
  assert.match(fs.readFileSync(path.join(r.s.run_dir, "tickets", "01-csv-export.md"), "utf8"), /^Status: done$/m);
  assert.equal(r.run("next-ticket").stdout.trim(), "DONE");
});

test("a merge that conflicts is aborted and left as it was, and a run head that goes red after merging two green sides is the human's", (t) => {
  const conflict = green(t);
  fs.writeFileSync(path.join(conflict.s.worktree, "csv.js"), "export const csv = 2;\n");
  git(conflict.s.worktree, "add", "csv.js"); git(conflict.s.worktree, "commit", "-qm", "Another csv.js");
  const before = git(conflict.s.worktree, "rev-parse", "HEAD");
  assert.equal(lastLine(conflict.stage("merge", "01")), `ATTENTION 01: merging ${conflict.branch} into feature/csv-export conflicts in csv.js, so the merge was aborted`);
  assert.deepEqual([git(conflict.s.worktree, "rev-parse", "HEAD"), git(conflict.s.worktree, "status", "--porcelain")], [before, ""]);
  assert.ok(fs.existsSync(conflict.wt) && branches(conflict), "the ticket's worktree and branch are kept");

  const red = green(t);  // the run branch's own change is green without csv.js, the ticket's with it
  fs.writeFileSync(path.join(red.s.worktree, "package.json"), JSON.stringify({ name: "reports", scripts: { test: "test ! -f csv.js" } }));
  git(red.s.worktree, "commit", "-qam", "No csv.js wanted");
  assert.match(lastLine(red.stage("merge", "01")), /^ATTENTION 01: verify --full is red at the run head \w{7} after merging two green sides, red_cause \w+$/);
  assert.match(fs.readFileSync(path.join(red.s.run_dir, "tickets", "01-csv-export.md"), "utf8"), /^Status: in-progress$/m, "the ticket isn't done");
});

// An attempt that commits csv.js with index.js broken by `word`, so each word fails the typecheck its own way.
const broken = (r, word) => ({ files: { "csv.js": "1\n", "index.js": `const ${word} = ;\n` }, commit: `Try ${word}`, write: { [r.impl]: report("DONE") } });
const round = (r) => r.node("run-state.mjs", ["round", "implement:01", "--run", r.s.id]);

test("fix rounds 1 and 2 resume the child's session with the evidence's path, round 3 is a fresh child on opus told a prior implementer tried twice, and round implement refuses a fourth with ESCALATE", (t) => {
  const r = ticketReady(t);
  r.play(["alpha", "beta", "gamma", "delta"].map((w) => broken(r, w)));
  const evidence = path.join(r.tickets, "evidence.json");
  assert.match(lastLine(r.stage("implement", "01")), /^ROUND 01: verify --full is red at \w{7}, red_cause introduced$/);
  for (const n of [1, 2, 3]) {
    assert.equal(lastLine(round(r)), `OK implement:01 round ${n}/3`);
    assert.match(lastLine(r.stage("implement", "01")), /^ROUND 01:/);
  }
  const [first, ...rest] = r.calls(), session = flag(first.argv, "--session-id");
  assert.equal(flag(first.argv, "--model"), "sonnet");
  for (const [i, call] of rest.slice(0, 2).entries()) {
    assert.deepEqual([flag(call.argv, "--resume"), flag(call.argv, "--model"), call.argv.includes("--session-id")], [session, "sonnet", false], `round ${i + 1} resumes`);
    assert.match(call.stdin, new RegExp(`^verify --full is red at \\w{7}, red_cause introduced: ${evidence} has each failing check's digest and log\\. Fix what it shows\\.`));
    assert.ok(call.stdin.includes(`the last one is now ${path.join(r.tickets, `implementation.round${i + 1}.md`)}`), "its last report was moved aside");
    assert.ok(!call.stdin.includes("run_dir:"), "and nothing else");
  }
  const third = rest[2];
  assert.ok(!third.argv.includes("--resume"));
  assert.notEqual(flag(third.argv, "--session-id"), session, "round 3 is a fresh child");
  assert.equal(flag(third.argv, "--model"), "opus", "on models.implement_escalated");
  assert.match(third.stdin, /^run_dir: /);
  assert.match(third.stdin, /A prior implementer has worked on this ticket and tried twice to fix it; you own it now\./);
  assert.ok(third.stdin.includes(evidence));
  const sessions = r.state().dispatches.filter((d) => d.stage === "implement:01").map((d) => [d.round, d.session]);
  assert.deepEqual(sessions, [[undefined, session], [1, session], [2, session], [3, flag(third.argv, "--session-id")]]);
  const escalated = round(r);
  assert.equal(escalated.status, 5);
  assert.equal(escalated.stdout.trim(), "ESCALATE implement:01: rounds 3/3");
  assert.match(fs.readFileSync(path.join(r.s.run_dir, "run.log"), "utf8"), /escalation: implement:01 rounds 3\/3\n/);
});

test("an attempt that made no commits costs no round, and the same failure twice escalates early", (t) => {
  const r = ticketReady(t);
  r.play([broken(r, "alpha"), { write: { [r.impl]: report("DONE") } }, { ...broken(r, "alpha"), files: { ...broken(r, "alpha").files, "notes.txt": "again\n" } }]);
  r.stage("implement", "01");
  assert.equal(lastLine(round(r)), "OK implement:01 round 1/3");
  assert.match(lastLine(r.stage("implement", "01")), /^ROUND 01:/);
  assert.equal(lastLine(round(r)), "OK implement:01 round 1/3: the last attempt made no commits, so it cost no round");
  assert.match(lastLine(r.stage("implement", "01")), /^ROUND 01:/);
  const same = round(r);
  assert.equal(same.status, 5);
  assert.equal(same.stdout.trim(), "ESCALATE implement:01: the same failure as round 1");
  assert.equal(r.state().rounds["implement:01"].n, 1);
});

test("BLOCKED: bad_plan resets the ticket's commits for the planner's one amendment, which a fresh child implements; a second bad plan, or intent_gap, is the human's", (t) => {
  const r = ticketReady(t);
  const cut = git(r.s.worktree, "rev-parse", "HEAD");
  r.play([{ ...CSV, write: { [r.impl]: report("BLOCKED", { cause: "bad_plan" }) } },
    { files: { "notes.txt": "1\n" }, commit: "Follow the amended plan", write: { [r.impl]: report("BLOCKED", { cause: "bad_plan" }) } }]);
  assert.equal(lastLine(r.stage("implement", "01")), "AMEND 01: BLOCKED: bad_plan, so the ticket's commits are reset and the planner amends the plan");
  assert.equal(git(r.wt, "rev-parse", "HEAD"), cut, "the ticket's commits are gone");
  assert.ok(!fs.existsSync(path.join(r.wt, "csv.js")));
  assert.ok(!fs.existsSync(path.join(r.tickets, "evidence.json")), "a blocked child isn't verified");
  r.run("dispatch", "plan:01");
  fs.writeFileSync(path.join(r.tickets, "plan.md"), "---\nstatus: ready\nticket: 01-csv-export\n---\n\n# Plan 01: CSV export, amended\n");
  r.run("done", "plan:01");
  assert.equal(lastLine(r.stage("implement", "01")), "ATTENTION 01: BLOCKED: bad_plan again, after the planner's one amendment");
  const [first, second] = r.calls();
  assert.ok(second.argv.includes("--session-id") && !second.argv.includes("--resume"), "the amended plan gets a fresh child");
  assert.notEqual(flag(second.argv, "--session-id"), flag(first.argv, "--session-id"));
  assert.match(second.stdin, /\n\nImplement the plan\.\n$/);

  const gap = ticketReady(t);
  gap.play([{ ...CSV, write: { [gap.impl]: report("BLOCKED", { cause: "intent_gap" }) } }]);
  assert.equal(lastLine(gap.stage("implement", "01")), "ATTENTION 01: BLOCKED: intent_gap, the spec leaves open what to build");
});

test("BLOCKED: environment is the human's, and every command Claude Code denied the child is copied from its result into the report", (t) => {
  const r = ticketReady(t);
  r.play([{ write: { [r.impl]: report("BLOCKED", { cause: "environment" }) }, denied: ["curl -sI https://registry.npmjs.org/csv", "docker compose up -d"] }]);
  assert.equal(lastLine(r.stage("implement", "01")), "ATTENTION 01: BLOCKED: environment, see implementation.md");
  assert.ok(fs.readFileSync(r.impl, "utf8").endsWith("\nDenied, as the child's result records it:\n"
    + "- `Bash: curl -sI https://registry.npmjs.org/csv`\n- `Bash: docker compose up -d`\n"));
});

test("NEEDS_CONTEXT gets one researcher dispatch, whose answer the resumed child is pointed at; a second NEEDS_CONTEXT is the human's", (t) => {
  const r = ticketReady(t);
  const ask = (q) => ({ write: { [r.impl]: report("NEEDS_CONTEXT", { more: `question: ${q}\n` }) } });
  r.play([ask("How does the CSV package quote a field?"), ask("And a newline?")]);
  const context = path.join(r.tickets, "context.md");
  assert.equal(lastLine(r.stage("implement", "01")), `RESEARCH 01: NEEDS_CONTEXT, so one researcher dispatch answers its question in ${context}`);
  r.run("dispatch", "context:01");
  fs.writeFileSync(context, "# How does the CSV package quote a field?\n\nIn double quotes.\n\nStatus: ok\n");
  r.run("done", "context:01");
  assert.equal(lastLine(r.stage("implement", "01")), "ATTENTION 01: NEEDS_CONTEXT again, after its one researcher dispatch");
  const [first, second] = r.calls();
  assert.equal(flag(second.argv, "--resume"), flag(first.argv, "--session-id"), "the same child, resumed");
  assert.ok(second.stdin.startsWith(`The answer to your question is in ${context}. Carry on with the plan.`));
});

// qa's stage on ticket 01 as the orchestrator records it: dispatched, the test files it changed (null deletes one)
// committed on the ticket's branch by name, its qa.json written, then done.
function qaWalks(r, files = {}) {
  r.run("dispatch", "qa:01");
  write(r.wt, files);
  if (Object.keys(files).length) { git(r.wt, "add", "--", ...Object.keys(files)); git(r.wt, "commit", "-qm", "Pin SC-001"); }
  fs.writeFileSync(path.join(r.tickets, "qa.json"), JSON.stringify({ ticket: "01-csv-export", status: "done", criteria: [] }));
  r.run("done", "qa:01");
}
const PINNED_PASS = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\n'
  + 'test("[r] SC-001: the app answers", async () => assert.equal((await fetch(`${process.env.BASE_URL}/`)).status, 200));\n';
const NO_CSV = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport fs from "node:fs";\n'
  + 'test("[old] SC-004: the reports offer no CSV", () => assert.ok(!fs.existsSync("csv.js")));\n';

test("with an app to walk, a green DONE ticket goes to qa before it merges, and verify then judges the ticket's head again with qa's pinned tests", (t) => {
  const recipe = { ...RECIPE, apps: [{ ...RECIPE.apps[0], dev: "PORT={port:app} node server.mjs", health: "http://localhost:{port:app}/" }], pinned: ["e2e"] };
  const r = ticketReady(t, { recipe, files: { "server.mjs": STUB_SERVER } });
  const alive = path.join(r.p.dir, ".alive");  // the stub app lives by it
  fs.writeFileSync(alive, ""); fs.writeFileSync(path.join(r.p.dir, ".factory/env.local"), `ALIVE=${alive}\n`);
  t.after(() => fs.rmSync(alive, { force: true }));
  r.play([{ ...CSV, write: { [r.impl]: report("DONE") } }]);
  assert.match(lastLine(r.stage("implement", "01")), /^QA 01: DONE, and verify --full is green at \w{7}, so qa walks ticket 01's criteria$/);
  assert.equal(r.stage("merge", "01").status, 2, "nothing merges before qa walks it");
  const pinned = `e2e/${r.s.id}-01-csv-export.test.mjs`;
  qaWalks(r, { [pinned]: PINNED_PASS });
  assert.equal(lastLine(r.stage("verify", "01")), `MERGE 01: DONE, and verify --full is green at ${git(r.wt, "rev-parse", "HEAD").slice(0, 7)}`);
  const pins = (file) => JSON.parse(fs.readFileSync(file, "utf8")).checks.filter((c) => c.pinned).map((c) => [c.check, c.status]);
  assert.deepEqual(pins(path.join(r.tickets, "evidence.json")), [[pinned, "pass"]], "qa's committed test is a pinned check");
  assert.match(lastLine(r.stage("merge", "01")), /^MERGED 01:/);
  assert.deepEqual(pins(path.join(r.s.run_dir, "evidence.json")), [[pinned, "pass"]], "rerun at the run head");
});

test("a red only in pinned tests goes to qa at no round's cost: a test qa rules fail is named in the fix round with verify --pinned, and one it supersedes lets the ticket merge", (t) => {
  const old = "e2e/old-01-no-csv.test.mjs";
  for (const ruling of ["fail", "superseded"]) {
    const r = ticketReady(t, { recipe: { ...RECIPE, pinned: ["e2e"] }, files: { [old]: NO_CSV } });
    r.play([{ ...CSV, write: { [r.impl]: report("DONE") } }, {}]);
    assert.equal(lastLine(r.stage("implement", "01")), `QA 01: verify --full is red only in pinned tests at ${git(r.wt, "rev-parse", "HEAD").slice(0, 7)}: ${old}, so qa rules on them`);
    assert.equal(r.state().rounds, undefined);
    qaWalks(r, ruling === "superseded" ? { [old]: null } : {});
    if (ruling === "superseded") { assert.match(lastLine(r.stage("verify", "01")), /^MERGE 01:/, ruling); continue; }
    assert.match(lastLine(r.stage("verify", "01")), /^ROUND 01: verify --full is red at \w{7}, red_cause introduced$/);
    assert.equal(lastLine(r.node("run-state.mjs", ["round", "implement:01", "--run", r.s.id])), "OK implement:01 round 1/3", "the ruling cost none");
    r.stage("implement", "01");
    const { stdin } = r.calls().at(-1);
    assert.ok(stdin.includes(` Failing pinned tests: ${old}. Make each pass by changing the product code; one the spec contradicts goes under `
      + `concerns:, untouched, for qa to rule on. \`node ${path.join(SCRIPTS, "verify.mjs")} --pinned <path>\` runs one with the apps up.`), stdin);
    r.run("dispatch", "qa:01");
    assert.deepEqual(["qa.json", "qa.round1.json"].map((f) => fs.existsSync(path.join(r.tickets, f))), [false, true], "qa's next dispatch moves its last qa.json aside");
  }
});

// run-stage implement started in the background as the orchestrator starts it; resolves once the fake child has played
// its step and hangs, with a function that kills both (one process group) the way a session that dies takes its
// background tasks with it.
async function background(t, r) {
  fs.rmSync(path.join(r.fake, "hanging"), { force: true });
  const bg = spawn(process.execPath, [path.join(SCRIPTS, "run-stage.mjs"), "implement", "01", "--run", r.s.id], { cwd: r.p.dir, env: r.env, detached: true, stdio: "ignore" });
  const gone = new Promise((resolve) => bg.on("exit", resolve));
  t.after(() => { try { process.kill(-bg.pid, "SIGKILL"); } catch {} });
  for (const end = Date.now() + 60_000; !fs.existsSync(path.join(r.fake, "hanging")); await new Promise((ok) => setTimeout(ok, 50))) {
    assert.ok(Date.now() < end, "the child never got going");
  }
  return () => { process.kill(-bg.pid, "SIGKILL"); return gone; };
}
const crash = async (t, r) => (await background(t, r))();
// one assistant message, as a child that has started working prints it
const SPOKE = { type: "assistant", parent_tool_use_id: null, message: { id: "msg-1", role: "assistant", content: [{ type: "text", text: "Writing the export." }] } };

test("reconcile commits what a cut-off implementer left uncommitted as a wip commit on the ticket's branch, never .factory/, and verify --fast checks it there", async (t) => {
  const r = ticketReady(t);
  r.play([{ files: { "csv.js": "export const csv = 1;\n", "lib/rows.js": "export const rows = [];\n" }, print: [SPOKE], hang: true }]);
  const kill = await background(t, r);
  const working = r.node("run-state.mjs", ["reconcile", "--run", r.s.id]);
  assert.equal(working.status, 6);
  assert.match(working.stdout, /^WORKING implement:01: its child, pid \d+, still runs$/m);
  assert.equal(git(r.wt, "rev-list", "--count", "HEAD"), "2", "nothing is salvaged under a child that still runs");
  await kill();
  fs.writeFileSync(path.join(r.wt, ".factory", "notes.md"), "not product\n");
  const out = r.run("reconcile").stdout;
  const sha = git(r.wt, "rev-parse", "HEAD");
  assert.equal(git(r.wt, "log", "-1", "--format=%s"), "wip(factory): salvaged from round 0", "the first attempt is round 0, before any fix round");
  assert.deepEqual(git(r.wt, "show", "--name-only", "--format=", "HEAD").split("\n"), ["csv.js", "lib/rows.js"]);
  assert.equal(git(r.wt, "status", "--porcelain"), "?? .factory/notes.md", ".factory/ is never salvaged");
  assert.match(out, new RegExp(`^salvaged ${sha.slice(0, 7)} on ${r.branch}: wip\\(factory\\): salvaged from round 0$`, "m"));
  assert.match(out, /^run-apps down$/m);
  assert.match(out, /^CONTINUE implement:01 from \w{7}: its child was cut off$/m);
  const fast = JSON.parse(fs.readFileSync(path.join(r.tickets, "evidence-fast.json"), "utf8"));
  assert.deepEqual([fast.sha, fast.green], [sha, true], "the salvaged tree's own fast checks");
  assert.match(out, /^ticket 01 verify fast: green=true /m);
  assert.match(out, /^STARTED 01-csv-export$/m, "then the ticket frontier");
  assert.match(fs.readFileSync(path.join(r.s.run_dir, "run.log"), "utf8"), /run: \S+ implement:01 wip\(factory\): salvaged from round 0 at \w{7}\n/);
});

test("what a dead implementer left is salvaged even in a run that stopped needs-human, whose attention item decides what comes next", async (t) => {
  const r = ticketReady(t);
  r.play([{ files: { "csv.js": "export const csv = 1;\n" }, print: [SPOKE], hang: true }]);
  await crash(t, r);
  r.run("set", "stage", "needs-human");  // another ticket's stop, say, while this one's child still ran
  const out = r.run("reconcile").stdout;
  assert.match(out, /^salvaged \w{7} on \S+: wip\(factory\): salvaged from round 0$/m);
  assert.equal(git(r.wt, "status", "--porcelain"), "");
  assert.doesNotMatch(out, /^CONTINUE/m);
});

test("a cut-off attempt is continued in its own round, resuming the child's session it left output in, so an attempt that made nothing costs no round", async (t) => {
  const r = ticketReady(t);
  r.play([broken(r, "alpha"), { print: [SPOKE], hang: true }, broken(r, "beta")]);
  assert.match(lastLine(r.stage("implement", "01")), /^ROUND 01:/);
  assert.equal(lastLine(round(r)), "OK implement:01 round 1/3");
  await crash(t, r);  // round 1's attempt, cut off before it made anything
  assert.doesNotMatch(r.run("reconcile").stdout, /^salvaged/m, "it left nothing uncommitted");
  assert.match(lastLine(r.stage("implement", "01")), /^ROUND 01:/);
  const [first, second, third] = r.calls(), session = flag(first.argv, "--session-id");
  assert.deepEqual([flag(second.argv, "--resume"), flag(third.argv, "--resume")], [session, session]);
  assert.deepEqual(r.state().dispatches.filter((d) => d.stage === "implement:01").map((d) => d.round), [undefined, 1, 1], "the continued attempt is still round 1's");
  assert.equal(lastLine(round(r)), "OK implement:01 round 2/3", "the cut-off attempt cost no round");
  assert.equal(lastLine(round(r)), "OK implement:01 round 2/3", "and a round asked for again before its attempt, as a resume after a stop there does, is counted once");
  assert.equal(r.state().rounds["implement:01"].n, 2);
});

test("a child cut off before it left a session to resume is started afresh, pointed at the git log since its dispatch and at its report", async (t) => {
  const r = ticketReady(t);
  r.play([{ write: { [r.impl]: "# Implementation 01\n" }, hang: true }, { ...CSV, write: { [r.impl]: report("DONE") } }]);
  await crash(t, r);
  r.run("reconcile");
  const sha = r.state().dispatches.find((d) => d.stage === "implement:01").sha;
  assert.match(lastLine(r.stage("implement", "01")), /^MERGE 01:/);
  const [first, second] = r.calls();
  assert.ok(!second.argv.includes("--resume"), "the first session has no conversation to resume");
  assert.notEqual(flag(second.argv, "--session-id"), flag(first.argv, "--session-id"));
  assert.match(second.stdin, /^run_dir: /, "a fresh child gets the plan's lines");
  assert.ok(second.stdin.includes(`A previous attempt at this ticket was cut off before it left a session to resume. \`git log --oneline ${sha}..HEAD\` lists what it committed, `
    + `and ${path.join(r.tickets, "implementation.round1.md")} what it reported.`), second.stdin);
});

// What Claude Code prints when a 429 ends a child's turn, as probed (docs/platform-facts.md, fact 13).
const LIMIT = { type: "assistant", parent_tool_use_id: null, error: "rate_limit", is_api_error_message: true, api_error_status: 429,
  message: { id: "msg-2", model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later." }] } };

test("a child that stops at the usage limit is SUSPENDED, never a round: nothing is judged, the run waits suspended, and resumed it carries on in its session", (t) => {
  const r = ticketReady(t);
  r.play([{ ...CSV, print: [SPOKE, LIMIT] }, { write: { [r.impl]: report("DONE") } }]);
  const suspended = "SUSPENDED 01: the child stopped at the usage limit, which costs no round";
  assert.equal(lastLine(r.stage("implement", "01")), suspended);
  assert.ok(!fs.existsSync(path.join(r.tickets, "evidence.json")), "nothing was verified");
  assert.ok(!r.state().stages_done.includes("implement:01"));
  r.run("set", "stage", "suspended");
  assert.match(r.run("status").stdout, new RegExp(`^${r.s.id}\\s+suspended\\s`, "m"));
  assert.match(r.run("reconcile").stdout, /^CONTINUE implement:01 from \w{7}: its child stopped at the usage limit$/m);
  assert.match(lastLine(r.stage("implement", "01")), /^MERGE 01:/);
  const [first, second] = r.calls();
  assert.equal(flag(second.argv, "--resume"), flag(first.argv, "--session-id"));
  assert.ok(second.stdin.startsWith("Carry on with the plan where you left off."), second.stdin);
  assert.equal(r.state().rounds, undefined, "no round was counted");
});

test("a resume that finds a ticket's implement stage done continues nothing, and run-stage verify judges the ticket again without starting a child", (t) => {
  const r = green(t);
  const before = r.state().dispatches.length;
  const out = r.run("reconcile").stdout;
  assert.match(out, /^done: research spec builder-check tickets plan:01 implement:01$/m);
  assert.doesNotMatch(out, /^CONTINUE/m);
  const fast = JSON.parse(fs.readFileSync(path.join(r.s.run_dir, "evidence-fast.json"), "utf8"));
  assert.equal(fast.sha, git(r.s.worktree, "rev-parse", "HEAD"), "with nothing cut off, the run branch's fast checks");
  assert.match(out, /^verify fast: green=false .* app\/test=fail/m, "where the ticket isn't merged yet");
  assert.match(out, /^STARTED 01-csv-export$/m);
  assert.match(lastLine(r.stage("verify", "01")), /^MERGE 01: DONE, and verify --full is green at \w{7}$/);
  assert.deepEqual([r.calls().length, r.state().dispatches.length], [1, before]);
});
