// ci.test.mjs — the CI stage's scripts spawned as processes on a build run whose PR #7 is open on o/r (a GitHub URL
// rewritten to a local bare remote), with a fake `gh` on PATH answering REST calls from fixtures: ci-watch, its feed into
// merge-decision, run-state round ci, and run-stage ci-fix with a fake `claude` in place of the implementer child.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { project, script, startRun, fakeClis, githubOrigin, write } from "./harness.mjs";

const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
// red once broken.js exists
const RECIPE = { apps: [{ name: "app", type: "backend", path: ".", checks: { test: "test ! -f broken.js" } }] };

// The fake implementer child: each call appends { argv, stdin, cwd, pid } to calls.jsonl in its dir and plays the next
// step of steps.json, writing `files` into its cwd (committed by name when the step has `commit`) and `write` (absolute
// paths) as they are, then printing a stream-json result for its session that spent 15 tokens.
const FAKE = `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path"), { execFileSync } = require("node:child_process");
const dir = process.env.FAKE_CLAUDE, argv = process.argv.slice(2), stdin = fs.readFileSync(0, "utf8");
const log = path.join(dir, "calls.jsonl"), n = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\\n").length : 0;
fs.appendFileSync(log, JSON.stringify({ argv, stdin, cwd: process.cwd(), pid: process.pid }) + "\\n");
const step = JSON.parse(fs.readFileSync(path.join(dir, "steps.json"), "utf8"))[n] || {};
const at = (k) => argv[argv.indexOf(k) + 1], session = argv.includes("--resume") ? at("--resume") : at("--session-id");
for (const [f, text] of Object.entries(step.files || {})) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); }
if (step.commit) { execFileSync("git", ["add", "--", ...Object.keys(step.files)]); execFileSync("git", ["commit", "-qm", step.commit]); }
for (const [f, text] of Object.entries(step.write || {})) fs.writeFileSync(f, text);
console.log(JSON.stringify({ type: "result", subtype: "success", session_id: session, modelUsage: { [at("--model")]: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0 } } }));
`;
const report = (status) => `# CI fix\n\n- abc1234 Fix the failing step: CI's\n\nstatus: ${status}\nblocked_cause: none\nassumptions:\n- none\nconcerns:\n- none\ndenied:\n- none\n`;

// A run of the workflow `CI`, as GET /actions/runs lists it.
const wf = (id, conclusion, { attempt = 1, status = "completed", name = "CI" } = {}) =>
  ({ id, name, event: "pull_request", status, conclusion: status === "completed" ? conclusion : null, run_attempt: attempt, html_url: `https://github.com/o/r/actions/runs/${id}` });
// One attempt's jobs: each [id, job, the step that failed or null].
const jobs = (...list) => ({ jobs: list.map(([id, name, failed]) => ({ id, name, conclusion: failed ? "failure" : "success", html_url: `https://github.com/o/r/actions/jobs/${id}`,
  steps: [{ name: "Set up job", conclusion: "success" }, { name: failed ?? "Run tests", conclusion: failed ? "failure" : "success" }] })) });

// A build run past its review, its one ticket merged and PR #7 open, with .github/workflows/ci.yml on the base (unless
// `workflows` is false). ci(answers, args) runs ci-watch from the main checkout, polling at once, against a fake gh that
// answers: `head` (the head's runs, poll by poll), `base` (the base head's runs), `jobs` ("<run>/<attempt>" -> jobs),
// `logs` (job id -> its log) and each rerun-failed-jobs POST. fix() runs run-stage ci-fix with the fake claude first on
// PATH, playing the steps play() sets; every fake child is killed after the test, pass or fail.
function ciReady(t, { config = {}, workflows = true } = {}) {
  const p = project({ recipe: RECIPE, config }); githubOrigin(p);
  const s = startRun(p, workflows ? { ".github/workflows/ci.yml": "on: pull_request\n" } : {});
  p.git("push", "-q", "origin", "main");
  const bin = tmp("factory-bin-"), fake = tmp("factory-claude-");
  fs.writeFileSync(path.join(bin, "claude"), FAKE, { mode: 0o755 });
  const play = (steps) => fs.writeFileSync(path.join(fake, "steps.json"), JSON.stringify(steps));
  play([]);
  const claude = () => { const f = path.join(fake, "calls.jsonl"); return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []; };
  t.after(() => { for (const { pid } of claude()) try { process.kill(pid, "SIGKILL"); } catch {} });
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, FAKE_CLAUDE: fake, CLAUDE_CONFIG_DIR: tmp("factory-config-") };
  delete env.CLAUDE_CODE_SESSION_ID;
  const rs = (...args) => { const r = script("run-state.mjs", p.dir, [...args, "--run", s.id], { env }); assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}${r.stdout}`); return r; };
  rs("set", "route", "build"); rs("set", "branch", "feature/signup"); rs("set", "target_branch", "main");
  for (const stage of ["research", "spec", "builder-check"]) { rs("dispatch", stage); write(s.run_dir, { [`${stage}.md`]: `# ${stage}\n` }); rs("done", stage); }
  rs("approve", "spec", "approved");
  rs("dispatch", "tickets"); write(s.run_dir, { "tickets/01-signup.md": "# 01: Signup\n\nStatus: ready-for-agent\nBlocked by: none\n" }); rs("done", "tickets");
  rs("ticket", "01", "done");
  s.commit({ "src/signup.js": "export const signup = () => 'Welcome';\n" }, "Add the signup form");
  write(s.run_dir, { "pr.json": JSON.stringify({ repo: "o/r", number: 7, url: "https://github.com/o/r/pull/7", head: "feature/signup", base: "main", draft: false, labels: ["factory"], comments: [] }) });
  const head = () => s.git("rev-parse", "HEAD"), base = p.git("rev-parse", "main");
  const canned = tmp("factory-canned-");
  let n = 0;
  const file = (text) => { const f = path.join(canned, `${n++}`); fs.writeFileSync(f, typeof text === "string" ? text : JSON.stringify(text)); return f; };
  let gh;
  const ci = ({ head: polls = [], base: basePolls = [[]], jobs: attempts = {}, logs = {} } = {}, args = []) => {
    gh = fakeClis({ gh: [
      { match: new RegExp(`^api repos/o/r/actions/runs\\?head_sha=${head()}&per_page=100$`), file: polls.map((runs) => file({ total_count: runs.length, workflow_runs: runs })) },
      { match: new RegExp(`^api repos/o/r/actions/runs\\?head_sha=${base}&per_page=100$`), file: basePolls.map((runs) => file({ total_count: runs.length, workflow_runs: runs })) },
      ...Object.entries(attempts).map(([key, value]) => { const [id, attempt] = key.split("/"); return { match: new RegExp(`^api repos/o/r/actions/runs/${id}/attempts/${attempt}/jobs\\?per_page=100$`), file: file(value) }; }),
      ...Object.entries(logs).map(([id, text]) => ({ match: new RegExp(`^api repos/o/r/actions/jobs/${id}/logs$`), file: file(text) })),
      { match: /^api -X POST repos\/o\/r\/actions\/runs\/\d+\/rerun-failed-jobs$/, file: file("") },
    ].filter((rule) => rule.file.length) });  // with no polls, nothing answers the head's runs
    return script("ci-watch.mjs", p.dir, ["--every", "0", ...args, "--run", s.id], { env: { ...env, PATH: gh.bin + path.delimiter + env.PATH } });
  };
  const fix = () => script("run-stage.mjs", p.dir, ["ci-fix", "--run", s.id], { env });
  const calls = () => gh.calls("gh");
  const read = (f) => fs.readFileSync(path.join(s.run_dir, f), "utf8");
  const json = (f) => JSON.parse(read(f));
  // one of merge-decision's facts at the run head, its CI fact unless named
  const fact = (name = "ci_green_at_head") => {
    const r = script("merge-decision.mjs", p.dir, ["--run", s.id], { env: { ...env, PATH: gh.bin + path.delimiter + env.PATH } });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    return json("decision.json").facts.find((f) => f.name === name);
  };
  return { p, s, env, rs, head, base, ci, calls, read, json, fact, play, claude, fix };
}
const lastLine = (r) => r.stdout.trim().split("\n").at(-1);
const reruns = (r) => r.calls().filter((a) => a[2] === "POST").map((a) => a[3]);

test("green: ci-watch waits for every run on the head to complete, over REST, and CI green at HEAD feeds the merge decision", (t) => {
  const r = ciReady(t);
  const out = r.ci({ head: [[wf(11, null, { status: "in_progress" }), wf(12, "success", { name: "Lint" })], [wf(11, "success"), wf(12, "success", { name: "Lint" })]] });
  assert.equal(out.status, 0, out.stderr + out.stdout);
  assert.equal(lastLine(out), `CI green at ${r.head().slice(0, 7)}: 2 workflow runs passed`);
  const ci = r.json("ci.json");
  assert.deepEqual([ci.sha, ci.cause], [r.head(), "green"]);
  assert.deepEqual(ci.runs.map((x) => [x.id, x.name, x.conclusion, x.attempt]), [[11, "CI", "success", 1], [12, "Lint", "success", 1]]);
  assert.equal(r.calls().filter((a) => /head_sha=/.test(a[1])).length, 2, "it polled until the run in progress completed");
  assert.ok(r.calls().every((a) => a[0] === "api"), "REST only");
  assert.deepEqual(reruns(r), [], "nothing re-run");
  const fact = r.fact();
  assert.equal(fact.ok, true, fact.detail);
  // ci.json is of one head: a commit since leaves CI unread at HEAD
  r.s.commit({ "src/later.js": "1\n" });
  assert.equal(r.fact().ok, false);
});

test("flake: a failed workflow run's failed jobs are re-run once, over REST, and a pass on attempt 2 is a flake that feeds the merge decision", (t) => {
  const r = ciReady(t);
  const failed = [wf(11, "failure"), wf(12, "success", { name: "Lint" })], passed = [wf(11, "success", { attempt: 2 }), wf(12, "success", { name: "Lint" })];
  const answers = { head: [failed, [wf(11, null, { attempt: 2, status: "queued" }), wf(12, "success", { name: "Lint" })], passed], base: [[wf(31, "failure")]], jobs: { "11/1": jobs([101, "test", "Run tests"]), "31/1": jobs([301, "lint", "Run lint"]) } };
  const out = r.ci(answers);
  assert.equal(out.status, 0, out.stderr + out.stdout);
  assert.equal(lastLine(out), `CI flake at ${r.head().slice(0, 7)}: CI passed on attempt 2`);
  assert.deepEqual(reruns(r), ["repos/o/r/actions/runs/11/rerun-failed-jobs"], "only the failed run, and only its failed jobs");
  const ci = r.json("ci.json");
  assert.deepEqual([ci.cause, ci.reran, ci.note], ["flake", [11], undefined], "the base's red at another step is no note on a red the re-run cleared");
  assert.equal(fs.existsSync(path.join(r.s.run_dir, "logs", "ci-failure.log")), false);
  assert.equal(r.fact().ok, true, "a re-run flake counts as CI green at HEAD");
  // read again at the same head, a workflow run already re-run is never re-run: it is still the flake it was
  const again = r.ci({ ...answers, head: [passed] });
  assert.equal(lastLine(again), `CI flake at ${r.head().slice(0, 7)}: CI passed on attempt 2`);
  assert.deepEqual(reruns(r), []);
});

// A failing job's log as GitHub serves it: a byte-order mark, a timestamp on every line, ANSI colours.
const LOG = "\uFEFF2026-11-04T10:00:00.0000000Z ##[group]Run npm test\n2026-11-04T10:00:00.1000000Z \x1b[36;1mnpm test\x1b[0m\n"
  + "2026-11-04T10:00:01.0000000Z ✗ normalizeEmail lowercases the address\n2026-11-04T10:00:01.0000000Z   AssertionError: expected 'A@B.C' to equal 'a@b.c'\n"
  + "2026-11-04T10:00:02.0000000Z ##[error]Process completed with exit code 1.\n";
const STRIPPED = "##[group]Run npm test\nnpm test\n✗ normalizeEmail lowercases the address\n  AssertionError: expected 'A@B.C' to equal 'a@b.c'\n##[error]Process completed with exit code 1.\n";
// CI red at `CI / test / Run tests` on both attempts, the base green
const OURS = { head: [[wf(11, "failure")], [wf(11, "failure", { attempt: 2 })]], base: [[wf(31, "success")]],
  jobs: { "11/1": jobs([101, "test", "Run tests"]), "11/2": jobs([102, "test", "Run tests"], [103, "build", null]) }, logs: { 102: LOG } };

test("ours: a red its re-run repeats is the run's; the failing job's whole log is saved as ci-failure.log, timestamps and ANSI stripped, and its digest printed", (t) => {
  const r = ciReady(t);
  const out = r.ci(OURS);
  assert.equal(out.status, 0, out.stderr + out.stdout);
  assert.equal(lastLine(out), `CI ours at ${r.head().slice(0, 7)}: CI / test / Run tests`);
  assert.deepEqual(reruns(r), ["repos/o/r/actions/runs/11/rerun-failed-jobs"]);
  const log = path.join(r.s.run_dir, "logs", "ci-failure.log");
  assert.equal(r.read("logs/ci-failure.log"), `### CI / test (https://github.com/o/r/actions/jobs/102)\n${STRIPPED}`, "attempt 2's failed job, whole");
  assert.ok(out.stdout.includes(`  AssertionError: expected 'A@B.C' to equal 'a@b.c'\n##[error]Process completed with exit code 1.\nfull output: ${log}\n`), out.stdout);
  const ci = r.json("ci.json");
  assert.deepEqual([ci.cause, ci.failing, ci.log, ci.note], ["ours", ["CI / test / Run tests"], log, undefined]);
  assert.match(r.fact().detail, /^CI ours at/);
  // read again at the same head, its re-run is spent: still ours, and nothing re-run
  assert.equal(lastLine(r.ci({ ...OURS, head: [OURS.head[1]] })), `CI ours at ${r.head().slice(0, 7)}: CI / test / Run tests`);
  assert.deepEqual(reruns(r), []);
});

test("fix 17: inherited only when the same failing step is red on the base's head, which stops the run with attention-ci.md; a base red at another step is noted, and the red stays the run's", (t) => {
  const r = ciReady(t), sha = r.head().slice(0, 7);
  // the base's workflow run, still in progress at first, is waited for
  const out = r.ci({ ...OURS, base: [[wf(31, null, { status: "in_progress" })], [wf(31, "failure")]], jobs: { ...OURS.jobs, "31/1": jobs([301, "test", "Run tests"]) } });
  assert.equal(out.status, 1, out.stderr + out.stdout);
  const item = path.join(r.s.run_dir, "attention-ci.md");
  assert.deepEqual(out.stdout.trim().split("\n").slice(-2), [`CI inherited at ${sha}: CI / test / Run tests`, `needs-human: ${item}`]);
  assert.deepEqual(reruns(r), [], "the base's red is never re-run away");
  const ci = r.json("ci.json");
  assert.deepEqual([ci.cause, ci.base], ["inherited", { branch: "main", sha: r.base, failing: ["CI / test / Run tests"] }]);
  assert.match(r.read("logs/ci-failure.log"), /^### CI \/ test \(https:\/\/github\.com\/o\/r\/actions\/jobs\/101\)\nGitHub refused its log: fake gh: no canned reply/,
    "a log GitHub won't give is said in its place, and the cause stands");
  const text = r.read("attention-ci.md");
  assert.match(text, new RegExp(`^# .*\\n\\nRun \`${r.s.id}\`, stage \`ci\`\\.\\n\\n## What happened\\n.*\`CI / test / Run tests\`.*\`main\` at \`${r.base.slice(0, 7)}\``));
  assert.match(text, /## Evidence\n- `.*ci\.json`\n- `.*ci-failure\.log`\n/);
  // what brings the base's fix in: GitHub merges it into the PR, and the run branch follows, so CI is read at that head
  assert.match(text, new RegExp(`## Options\\n- \`node \\S+/plugin/scripts/sync-base\\.mjs before-merge --run ${r.s.id}\`: .*\\n- \`/factory resume ${r.s.id}\`: .*\\n- \`/factory abandon ${r.s.id}\`: `));
  assert.equal(r.json("state.json").stage, "needs-human");
  assert.equal(r.fact().ok, false);

  // the base red at another step: re-run, red again, ours, with the base's red noted
  const q = ciReady(t), lint = { base: [[wf(31, "failure")]], jobs: { ...OURS.jobs, "31/1": jobs([301, "lint", "Run lint"]) } };
  const other = q.ci({ ...OURS, ...lint });
  assert.equal(other.status, 0, other.stderr + other.stdout);
  assert.equal(lastLine(other), `CI ours at ${q.head().slice(0, 7)}: CI / test / Run tests`);
  assert.deepEqual(reruns(q), ["repos/o/r/actions/runs/11/rerun-failed-jobs"]);
  assert.match(q.json("ci.json").note, new RegExp(`^main at ${q.base.slice(0, 7)} is red too, at CI / lint / Run lint: not every step failing here, so the red is the run's$`));
  // one failing step the base shares, one it doesn't: still the run's
  const both = q.ci({ ...OURS, ...lint, head: [OURS.head[1]], jobs: { ...lint.jobs, "11/2": jobs([102, "test", "Run tests"], [103, "lint", "Run lint"]) }, logs: { 102: LOG, 103: LOG } });
  assert.equal(lastLine(both), `CI ours at ${q.head().slice(0, 7)}: CI / test / Run tests, CI / lint / Run lint`);
  assert.equal(q.json("state.json").stage, "tickets", "ours stops nothing: the fix round comes next");
});

test("infra: a workflow run not done in time, one cancelled, none at all, GitHub refusing a call, or a head with no workflow stops the run with attention-ci.md", (t) => {
  const r = ciReady(t), sha = r.head().slice(0, 7), item = path.join(r.s.run_dir, "attention-ci.md");
  for (const [answers, why, args = []] of [
    [{ head: [[wf(11, null, { status: "in_progress" })]] }, "CI still in_progress after 0 s", ["--wait", "0"]],
    [{ head: [[wf(11, "cancelled"), wf(12, "success", { name: "Lint" })]] }, "CI cancelled"],
    [{ head: [[]] }, `no workflow run appeared for ${sha} in 0 s`, ["--wait", "0"]],
    [{}, `GitHub refused repos/o/r/actions/runs?head_sha=${r.head()}&per_page=100: fake gh: no canned reply for ${JSON.stringify(["api", `repos/o/r/actions/runs?head_sha=${r.head()}&per_page=100`])}`],
  ]) {
    const out = r.ci(answers, args);
    assert.equal(out.status, 1, out.stderr + out.stdout);
    assert.deepEqual(out.stdout.trim().split("\n"), [`CI infra at ${sha}: ${why}`, `needs-human: ${item}`]);
    assert.deepEqual(reruns(r), [], "nothing is re-run or fixed");
    assert.equal(r.json("ci.json").cause, "infra");
    assert.ok(r.read("attention-ci.md").includes(`## What happened\nCI at \`${sha}\`: ${why}.`), r.read("attention-ci.md"));
    assert.equal(r.json("state.json").stage, "needs-human");
  }
  const bare = ciReady(t, { workflows: false }), out = bare.ci({ head: [[]] });
  assert.equal(out.status, 1);
  assert.match(out.stdout, /^CI infra at \w{7}: the head has no workflow in \.github\/workflows, so nothing runs CI on it$/m);
  assert.deepEqual(bare.calls(), [], "nothing to wait for");
});

test("fix 14: ours gets one CI fix round: round ci counts it, an implementer child fixes the run branch from ci-failure.log, verify --full judges it, and a second round ESCALATEs", (t) => {
  const r = ciReady(t);
  const refused = r.fix();
  assert.equal(refused.status, 2, "CI not read as ours, no CI fix");
  assert.match(refused.stderr, /ci\.json's cause is missing, and only ours starts a CI fix round/);
  assert.equal(r.ci(OURS).status, 0);
  assert.equal(r.rs("round", "ci").stdout.trim(), "OK ci round 1/1");
  assert.equal(r.rs("round", "ci").stdout.trim(), "OK ci round 1/1", "a resume that asks again before the attempt doesn't pay twice");
  const ciFix = path.join(r.s.run_dir, "ci-fix.md");
  r.play([{ files: { "src/signup.js": "export const signup = (email) => email.toLowerCase();\n" }, commit: "Lowercase the email", write: { [ciFix]: report("DONE") } }]);
  const out = r.fix();
  assert.equal(out.status, 0, out.stderr + out.stdout);
  assert.equal(lastLine(out), `PUSH: the fix round is green at ${r.head().slice(0, 7)}, so pr-open.mjs pushes it and CI is read again`);
  const [call] = r.claude();
  assert.equal(call.cwd, r.s.worktree, "the child fixes the run branch in the run worktree");
  assert.ok(call.argv.includes("--session-id") && !call.argv.includes("--resume"), "a fresh child");
  assert.equal(call.argv[call.argv.indexOf("--agent") + 1], "factory:implementer");
  const plan = path.join(r.s.run_dir, "ci-plan.md");
  for (const line of [`worktree: ${r.s.worktree}`, "ticket: ci-fix", `plan: ${plan}`, `implementation: ${ciFix}`]) assert.ok(call.stdin.split("\n").includes(line), line);
  const text = r.read("ci-plan.md");
  assert.ok(text.startsWith(`---\nstatus: ready\nticket: ci-fix\ncontext:\n  - ${path.join(r.s.run_dir, "logs", "ci-failure.log")}\n  - ${path.join(r.s.run_dir, "ci.json")}\n---\n`), text);
  assert.match(text, /`CI \/ test \/ Run tests`/);
  const e = r.json("evidence.json");
  assert.deepEqual([e.mode, e.sha, e.green], ["full", r.head(), true], "verify --full judged the run head");
  // the CI fix's implementer is judged as any other: its assessment is a merge fact, and the PR shows it
  assert.match(r.fact("implementer_confident").detail, /ci-fix\.md: no assessment/);
  assert.equal(script("pr-render.mjs", r.p.dir, ["--run", r.s.id], { env: r.env }).status, 0);
  assert.match(r.read("pr.md"), /^### CI fix\n\n```text\nassumptions:\n- none\n```/m);

  const spent = script("run-state.mjs", r.p.dir, ["round", "ci", "--run", r.s.id], { env: r.env });
  assert.equal(spent.status, 5);
  assert.equal(spent.stdout.trim(), "ESCALATE ci: rounds 1/1");
  r.rs("override", "ci_rounds", "one more round is worth it");
  assert.equal(r.rs("round", "ci").stdout.trim(), "OK ci round 2/1 (lifted)");
});

test("a CI fix round cut off is continued fresh, through its step, never as an agent to message", (t) => {
  const r = ciReady(t), log = path.join(r.s.run_dir, "logs", "ci-fix.1.jsonl");
  write(r.s.run_dir, { "logs/ci-fix.1.jsonl": JSON.stringify({ type: "assistant", session_id: "c-1", message: { content: [] } }) + "\n" });
  r.rs("dispatch", "ci-fix"); r.rs("dispatch", "ci-fix", "--log", log, "--pid", "999999", "--session", "c-1");
  assert.match(r.rs("reconcile", "--take-over").stdout, /^CONTINUE ci-fix from \w{7}: fresh$/m);
});

test("post-PR spend: a CI fix child's tokens count against the post-PR allowance, never the build's, and once it's spent the next CI round isn't dispatched", (t) => {
  const r = ciReady(t, { config: { caps: { tokens_post_pr: 10, ci_rounds: 2 } } });
  r.ci(OURS);
  r.rs("round", "ci");
  r.play([{ files: { "src/signup.js": "export const signup = 1;\n" }, commit: "Try a fix", write: { [path.join(r.s.run_dir, "ci-fix.md")]: report("DONE") } }]);
  assert.match(lastLine(r.fix()), /^PUSH: /);
  assert.match(r.rs("spend").stdout, /^tokens 0\/1400000\npost_pr 15\/10$/m, "the child's 15 tokens, spent after pr.json, are the allowance's");
  assert.equal(r.rs("round", "ci").stdout.trim(), "OK ci round 2/2");
  const refused = r.fix();
  assert.equal(refused.status, 4, refused.stderr + refused.stdout);
  assert.match(refused.stdout, /^BUDGET post_pr 15\/10: ci-fix not dispatched$/m);
  assert.equal(r.claude().length, 1, "no second child");
});
