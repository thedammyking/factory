// oneshot.test.mjs — the oneshot route (#59) through run-state.mjs and run-stage.mjs: the lane writes the run's one
// ticket, a planner's reroute sends it to build at research, and qa is skipped for a docs, refactor or maintenance type.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { project, sh } from "./harness.mjs";

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugin/scripts");
const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
// Spend is read from Claude Code's transcripts under CLAUDE_CONFIG_DIR, so no test reads the real ~/.claude.
const ENV = { ...process.env, CLAUDE_CONFIG_DIR: tmp("factory-claude-") };
delete ENV.CLAUDE_CODE_SESSION_ID;
const CHECK = "`/cart`, add two of one item, the total shows twice its price.";

// A oneshot run, triaged as `type`, on project p. run(...) is run-state; ok(...) asserts it exits 0.
function oneshot(p, { type = "bug", check = CHECK, env = ENV } = {}) {
  const node = (script, args, input = "", cwd = p.dir) => spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { cwd, input, env, encoding: "utf8" });
  const s = JSON.parse(node("run-state.mjs", ["init"], "Fix the cart total\n").stdout);
  const run = (...args) => node("run-state.mjs", [...args, "--run", s.id]);
  const ok = (...args) => { const r = run(...args); assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}${r.stdout}`); return r.stdout.trim(); };
  fs.writeFileSync(path.join(s.run_dir, "triage.md"), "The total ignores the quantity.\n\n```json\n"
    + JSON.stringify({ type, contract: "READY", size: "s", route: "oneshot", in_production: false, branch: "bugfix/cart-total", acceptance_check: check }) + "\n```\n");
  ok("set", "route", "oneshot");
  return { s, run, ok, node, state: () => JSON.parse(ok("get")) };
}
const ticket = (s) => path.join(s.run_dir, "tickets", "01-cart-total.md");

test("a oneshot's lane writes its one ticket from triage.md, covering the acceptance check, with no ticket gate, so it budgets as one ticket", () => {
  const p = project(), { s, run, ok } = oneshot(p);
  assert.equal(run("next-ticket").status, 2, "no ticket before the lane");
  ok("lane");
  assert.equal(fs.readFileSync(ticket(s), "utf8"), "# 01: cart total\n\nStatus: ready-for-agent\nBlocked by: none\n\n"
    + "The run's one ticket on the oneshot route: `triage.md` is its ticket and its spec.\n\n## Covers\n- [ ] acceptance: " + CHECK + "\n");
  assert.equal(ok("next-ticket"), "NEXT 01-cart-total");
  ok("ticket", "01", "in-progress");
  ok("dispatch", "plan:01");
  assert.match(ok("spend"), /^minutes \d+\/90$\ntokens \d+\/1400000$/m, "1.4M tokens and 90 minutes: one ticket");
  ok("lane");
  assert.match(fs.readFileSync(ticket(s), "utf8"), /^Status: in-progress$/m, "a second lane, after a resume, writes nothing");

  const none = oneshot(p, { check: "" });
  const r = none.run("lane");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /acceptance_check/);
  assert.equal(sh(none.s.worktree, "git", ["branch", "--show-current"]), "", "no lane without the ticket's criterion");
});

// The oneshot planned as the orchestrator plans its ticket, the plan's frontmatter saying `status`; done unless a
// reroute marks it.
const planned = ({ s, ok }, status, { done = true } = {}) => {
  ok("ticket", "01", "in-progress");
  ok("dispatch", "plan:01");
  fs.mkdirSync(path.join(s.run_dir, "tickets", "01"), { recursive: true });
  fs.writeFileSync(path.join(s.run_dir, "tickets", "01", "plan.md"), `---\nstatus: ${status}\nticket: 01-cart-total\n---\n\n# Plan 01: cart total\n\n`
    + "## Code map\n- `src/cart.js` (change): multiply by the quantity\n- `src/api/cart.ts` (change): send the quantity\n");
  if (done) ok("done", "plan:01");
};

test("reroute switches a oneshot to build at research, on the same branch and worktree with the same triage.md, and its budget waits for the tickets", () => {
  const p = project(), r = oneshot(p), { s, run, ok, state } = r;
  ok("lane");
  planned(r, "reroute", { done: false });
  const before = state(), triage = fs.readFileSync(path.join(s.run_dir, "triage.md"), "utf8");
  assert.equal(ok("reroute"), `rerouted ${s.id} to build: research comes next, on ${before.branch}`);
  const after = state();
  assert.equal(after.route, "build");
  assert.deepEqual([after.branch, after.worktree, after.base_sha], [before.branch, before.worktree, before.base_sha]);
  assert.equal(sh(s.worktree, "git", ["branch", "--show-current"]), before.branch);
  assert.equal(fs.readFileSync(path.join(s.run_dir, "triage.md"), "utf8"), triage);
  assert.ok(!fs.existsSync(path.join(s.run_dir, "tickets")), "the oneshot's ticket is no ticket of the build");
  assert.ok(fs.existsSync(path.join(s.run_dir, "oneshot", "01-cart-total.md")) && fs.existsSync(path.join(s.run_dir, "oneshot", "01", "plan.md")), "kept beside them");
  assert.match(fs.readFileSync(path.join(s.run_dir, "run.log"), "utf8"), new RegExp(`run: ${s.id} rerouted from oneshot to build\\n`));
  assert.equal(run("next-ticket").status, 2, "its tickets are the planner's, at the ticket gate");
  const resumed = ok("reconcile");
  assert.match(resumed, /^done: plan:01$/m, "a stop now resumes at research: the oneshot's plan is done");
  assert.doesNotMatch(resumed, /^CONTINUE /m);

  ok("dispatch", "research");
  assert.match(ok("spend"), /^minutes \d+\/90$\ntokens \d+\/1500000$/m, "no ticket count yet: the run's fallback");
  for (const [stage, file] of [["research", "research.md"], ["spec", "spec.md"], ["builder-check", "builder-check.md"]]) {
    if (stage !== "research") ok("dispatch", stage);
    fs.writeFileSync(path.join(s.run_dir, file), `# ${stage}\n`);
    ok("done", stage);
  }
  assert.match(run("dispatch", "tickets").stderr, /isn't approved/, "the spec gate holds a rerouted run");
  ok("approve", "spec", "approved");
  ok("dispatch", "tickets");
  assert.ok(!fs.existsSync(path.join(s.run_dir, "tickets.round0")), "nothing for the planner to take for a revision");
  fs.mkdirSync(path.join(s.run_dir, "tickets"));
  for (const n of ["01-cart-math", "02-cart-api", "03-cart-view"]) fs.writeFileSync(path.join(s.run_dir, "tickets", `${n}.md`), `# ${n}\n\nStatus: ready-for-agent\nBlocked by: none\n`);
  assert.match(ok("spend"), /^minutes \d+\/180$\ntokens \d+\/2800000$/m, "once the tickets are known, the budget is theirs");
  assert.match(run("reroute").stderr, /only a oneshot reroutes/);

  const built = oneshot(p);
  built.ok("lane");
  planned(built, "ready");
  built.ok("dispatch", "implement:01");
  const late = built.run("reroute");
  assert.equal(late.status, 2);
  assert.match(late.stderr, /from its plan/);
  assert.equal(built.state().route, "oneshot");
});

// A fake implementer child that reports DONE in the implementation.md its first message names, and commits nothing.
const FAKE = `#!${process.execPath}
const fs = require("node:fs"), input = fs.readFileSync(0, "utf8");
fs.writeFileSync(input.match(/^implementation: (.+)$/m)[1], "status: DONE\\nconcerns:\\n- none\\n");
console.log(JSON.stringify({ type: "result", session_id: "s", modelUsage: {} }));
`;

test("a docs, refactor or maintenance oneshot has no qa walk and merges as the run's one ticket on green checks; any other type is walked", () => {
  const bin = tmp("factory-bin-");
  fs.writeFileSync(path.join(bin, "claude"), FAKE, { mode: 0o755 });
  const env = { ...ENV, PATH: bin + path.delimiter + process.env.PATH };
  const recipe = { apps: [{ name: "app", type: "web", path: ".", dev: "node server.mjs", checks: { test: "true" } }] };
  for (const type of ["docs", "refactor", "maintenance", "bug"]) {
    const p = project({ recipe }), r = oneshot(p, { type, env });
    r.ok("lane");
    planned(r, "ready");
    const stage = (...args) => { const x = r.node("run-stage.mjs", [...args, "--run", r.s.id]); assert.equal(x.status, 0, x.stderr + x.stdout); return x.stdout.trim().split("\n").at(-1); };
    const verdict = stage("implement", "01");
    if (type === "bug") { assert.match(verdict, /^QA 01: DONE, and verify --full is green/, type); continue; }
    assert.match(verdict, /^MERGE 01: DONE, and verify --full is green/, type);
    assert.match(stage("merge", "01"), /^MERGED 01:/, type);
    assert.equal(r.ok("next-ticket"), "DONE", `${type}: on to the review`);
  }
});
