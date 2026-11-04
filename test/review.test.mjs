// review.test.mjs — the review stage's scripts spawned as processes on a build run whose tickets are all merged, on a
// throwaway project: run-state archive-review and round review, synthesize, and run-stage review-fix with a fake
// `claude` on PATH in place of the implementer child.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { project, sh, write } from "./harness.mjs";

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugin/scripts");
const git = (cwd, ...args) => sh(cwd, "git", args);
const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

// The fake implementer child: each call appends { argv, stdin, cwd, pid } to calls.jsonl in its dir and plays the next
// step of steps.json, writing `files` into its cwd (committed by name when the step has `commit`) and `write` (absolute
// paths) as they are, then printing a stream-json result for its session.
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

// red once broken.js exists
const RECIPE = { apps: [{ name: "app", type: "backend", path: ".", checks: { test: "test ! -f broken.js" } }] };
const SPEC = "---\nsurface: operate\n---\n\n# Orders\n\n## Success criteria\n- **SC-001** (profile: default, live-safe: yes): `/orders` lists the orders.\n";

// A build run on a throwaway project past its ticket gate, its one ticket done and merged into the run branch as the
// commit that adds src/a.js and src/b.js. node(script, args) runs a plugin script from the main checkout with the fake
// claude first on PATH, playing the steps play() sets; every fake child is killed after the test, pass or fail.
function reviewReady(t) {
  const p = project({ recipe: RECIPE });
  const bin = tmp("factory-bin-"), fake = tmp("factory-claude-");
  fs.writeFileSync(path.join(bin, "claude"), FAKE, { mode: 0o755 });
  const play = (steps) => fs.writeFileSync(path.join(fake, "steps.json"), JSON.stringify(steps));
  play([]);
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, FAKE_CLAUDE: fake, CLAUDE_CONFIG_DIR: tmp("factory-config-") };
  delete env.CLAUDE_CODE_SESSION_ID;
  const node = (script, args, input = "") => spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { cwd: p.dir, input, env, encoding: "utf8", timeout: 120_000 });
  const s = JSON.parse(node("run-state.mjs", ["init"], "Add an orders page\n").stdout);
  const run = (...args) => { const r = node("run-state.mjs", [...args, "--run", s.id]); assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}${r.stdout}`); return r; };
  const calls = () => { const f = path.join(fake, "calls.jsonl"); return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []; };
  t.after(() => { for (const { pid } of calls()) try { process.kill(pid, "SIGKILL"); } catch {} });
  write(s.run_dir, { "triage.md": "```json\n" + JSON.stringify({ type: "feature", in_production: false, branch: "feature/orders" }) + "\n```\n" });
  run("set", "route", "build");
  run("lane");
  for (const [stage, file, text] of [["research", "research.md", "# research\n"], ["spec", "spec.md", SPEC], ["builder-check", "builder-check.md", "# check\n"]]) {
    run("dispatch", stage); write(s.run_dir, { [file]: text }); run("done", stage);
  }
  run("approve", "spec", "approved");
  run("dispatch", "tickets");
  write(s.run_dir, { "tickets/01-orders.md": "# 01: Orders\n\nStatus: ready-for-agent\nBlocked by: none\n" });
  run("done", "tickets");
  run("approve", "tickets", "approved");
  run("ticket", "01", "done");
  write(s.worktree, { "src/a.js": "export const a = 1;\n", "src/b.js": "export const b = 2;\n" });
  git(s.worktree, "add", "src"); git(s.worktree, "commit", "-qm", "Add the orders page");
  const files = (f) => write(s.run_dir, f);
  const read = (f) => fs.readFileSync(path.join(s.run_dir, f), "utf8");
  const synth = () => { const r = node("synthesize.mjs", ["--run", s.id]); assert.equal(r.status, 0, r.stderr); return JSON.parse(read("findings.json")); };
  const fix = () => node("run-stage.mjs", ["review-fix", "--run", s.id]);
  return { p, s, node, run, play, calls, files, read, synth, fix };
}
const lastLine = (r) => { assert.equal(r.status, 0, r.stderr + r.stdout); return r.stdout.trim().split("\n").at(-1); };
const flag = (argv, name) => argv[argv.indexOf(name) + 1];
const block = (f) => [`- id: ${f.id}`, ...Object.entries(f).filter(([k]) => k !== "id").map(([k, v]) => `  ${k}: ${v}`)].join("\n");
const lens = (title, findings, first = "") => `${first}${first && "\n\n"}# ${title}\n\n${findings.map(block).join("\n")}\n\nverdict: needs-fixes\n`;
const report = (status) => `# Review fix\n\n- abc1234 Fix the findings: the review's\n\nstatus: ${status}\nblocked_cause: none\nassumptions:\n- none\nconcerns:\n- none\ndenied:\n- none\n`;

test("archive-review keeps every round: review-<lens>.md moves to the next free round, never over one, and dispatching a lens moves its last file aside first", (t) => {
  const r = reviewReady(t);
  r.files({ "review-code.md": "round one\n" });
  assert.equal(r.run("archive-review", "code").stdout.trim(), "archived review-code.md as review-code.round1.md");
  r.files({ "review-code.md": "round two\n", "review-code.round3.md": "kept\n" });
  assert.equal(r.run("archive-review", "code").stdout.trim(), "archived review-code.md as review-code.round4.md");
  assert.deepEqual(["review-code.round1.md", "review-code.round3.md", "review-code.round4.md"].map(r.read), ["round one\n", "kept\n", "round two\n"]);
  assert.ok(!fs.existsSync(path.join(r.s.run_dir, "review-code.md")));
  assert.equal(r.run("archive-review", "code").stdout.trim(), "no review-code.md to archive");
  const bad = r.node("run-state.mjs", ["archive-review", "qa", "--run", r.s.id]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /archive-review <code \| ui \| security>/);

  r.files({ "review-ui.md": "disposition: fix\n" });
  r.run("dispatch", "review-ui");
  assert.deepEqual([r.read("review-ui.round1.md"), fs.existsSync(path.join(r.s.run_dir, "review-ui.md"))], ["disposition: fix\n", false], "a dispatch with no output yet is working");
});

test("a review fix round gives the implementer only the open P0 and P1 fixes, re-runs verify --full, and names only the lenses that had them, on the fix diff; the next round resumes it, and a third escalates", (t) => {
  const r = reviewReady(t);
  const refused = r.fix();
  assert.equal(refused.status, 2, "no findings.json, no fix round");
  r.files({
    "review-code.md": lens("Code review", [
      { id: "code-01", severity: "P1", action: "fix", location: "src/a.js:1", claim: "The total ignores the quantity", evidence: "a = 1", fix: "Multiply by the quantity." },
      { id: "code-02", severity: "P2", action: "fix", location: "src/b.js:40", claim: "A helper name misleads" },
      { id: "code-03", severity: "P3", action: "note", location: "src/b.js:80", claim: "Spacing" },
    ]),
    "review-security.md": lens("Security review", [{ id: "security-01", severity: "P1", action: "fix", location: "src/b.js:1", claim: "The id reaches SQL unescaped", cwe: "CWE-89" }]),
    "review-ui.md": lens("UI review", [{ id: "ui-01", severity: "P2", action: "fix", location: "captures/orders-390-light.png: the header", claim: "The title wraps" }], "disposition: ship"),
  });
  assert.equal(r.synth().disposition, "fix");
  assert.equal(r.run("round", "review").stdout.trim(), "OK review round 1/2");
  assert.equal(r.run("round", "review").stdout.trim(), "OK review round 1/2", "a resume that asks again before the attempt doesn't pay twice");
  const before =git(r.s.worktree, "rev-parse", "HEAD");
  r.play([{ files: { "src/a.js": "export const a = 1 * 2;\n" }, commit: "Multiply by the quantity", write: { [path.join(r.s.run_dir, "review-fix.md")]: report("DONE") } }]);
  const head = () => git(r.s.worktree, "rev-parse", "HEAD");
  assert.equal(lastLine(r.fix()), `REVIEW code,security: the fix round is green at ${head().slice(0, 7)}, so the lenses that had its findings re-review review-fix.diff`);

  const [call] = r.calls();
  assert.equal(call.cwd, r.s.worktree, "the child fixes the run branch in the run worktree");
  assert.deepEqual(["--agent", "--model", "--add-dir", "--permission-mode", "--permission-prompts"].map((k) => flag(call.argv, k)), ["factory:implementer", "sonnet", r.s.run_dir, "acceptEdits", "none"]);
  assert.ok(call.argv.includes("--strict-mcp-config") && call.argv.includes("--session-id") && !call.argv.includes("--resume"), "round 1 is a fresh child");
  assert.ok(flag(call.argv, "--allowedTools").split(",").includes(`Bash(node ${SCRIPTS}/verify.mjs:*)`));
  for (const line of [`worktree: ${r.s.worktree}`, `plan: ${path.join(r.s.run_dir, "fixes.md")}`, `implementation: ${path.join(r.s.run_dir, "review-fix.md")}`]) {
    assert.ok(call.stdin.split("\n").includes(line), line);
  }
  const fixes = r.read("fixes.md");
  assert.match(fixes, /^context:\n  - src\/a\.js\n  - src\/b\.js\n/m, "the files the findings sit in");
  assert.match(fixes, /\*\*code-01\*\* \(P1, code\) `src\/a\.js:1`: The total ignores the quantity\n  Fix: Multiply by the quantity\./);
  assert.match(fixes, /\*\*security-01\*\* \(P1, security, CWE-89\) `src\/b\.js:1`: The id reaches SQL unescaped/);
  assert.doesNotMatch(fixes, /code-02|code-03|ui-01/, "a P2 goes to the PR and a P3 to deferred.md, never into the loop");
  assert.doesNotMatch(fixes, /a = 1/, "a lens's evidence, quoted from the diff, never reaches the plan");
  const e = JSON.parse(r.read("evidence.json"));
  assert.deepEqual([e.mode, e.sha, e.green], ["full", head(), true], "verify --full judged the run head");
  const diff = r.read("review-fix.diff");
  assert.match(diff, new RegExp(`^# Commits ${before.slice(0, 7)}\\.\\.${head().slice(0, 7)}\\n\\w+ Multiply by the quantity\\n\\n`, "m"), "only the fix's commits");
  assert.deepEqual([...diff.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]), ["src/a.js"]);

  // The lenses that had findings re-review: code keeps one open, security closes its own.
  r.run("dispatch", "review-code");
  r.run("dispatch", "review-security");
  r.files({
    "review-code.md": lens("Code review", [{ id: "code-01", status: "closed", note: "a = 1 * 2" }, { id: "code-04", severity: "P1", action: "fix", location: "src/a.js:1", claim: "The quantity is hard-coded as 2" }]),
    "review-security.md": lens("Security review", [{ id: "security-01", status: "closed", note: "unchanged since, and parameterised" }]),
  });
  assert.equal(r.synth().disposition, "fix");
  assert.equal(r.run("round", "review").stdout.trim(), "OK review round 2/2");
  r.play([{}, { files: { "src/a.js": "export const a = (q) => q;\n" }, commit: "Take the quantity", write: { [path.join(r.s.run_dir, "review-fix.md")]: report("DONE") } }]);
  assert.match(lastLine(r.fix()), /^REVIEW code: /);
  const second = r.calls()[1];
  assert.equal(flag(second.argv, "--resume"), flag(call.argv, "--session-id"), "round 2 resumes round 1's child");
  assert.match(second.stdin, /fixes\.md/);
  assert.match(r.read("fixes.md"), /\*\*code-04\*\*/);
  assert.doesNotMatch(r.read("fixes.md"), /code-01|security-01/, "a closed finding never goes round again");
  assert.match(r.read("review-fix.round1.md"), /^status: DONE$/m, "the round 1 report is kept beside the new one");

  const spent = r.node("run-state.mjs", ["round", "review", "--run", r.s.id]);
  assert.equal(spent.status, 5);
  assert.equal(spent.stdout.trim(), "ESCALATE review: rounds 2/2");
});

test("a fix round that turns verify red goes round again, and one that makes no commits stops for the human", (t) => {
  const r = reviewReady(t);
  r.files({ "review-code.md": lens("Code review", [{ id: "code-01", severity: "P1", action: "fix", location: "src/a.js:1", claim: "The total ignores the quantity" }]) });
  r.synth();
  r.run("round", "review");
  const report1 = path.join(r.s.run_dir, "review-fix.md");
  r.play([
    { files: { "broken.js": "1\n" }, commit: "Break the check", write: { [report1]: report("DONE") } },
    { write: { [report1]: report("DONE") } },
  ]);
  assert.match(lastLine(r.fix()), /^ROUND: verify --full is red at \w{7}, red_cause introduced$/);
  r.run("round", "review");
  assert.equal(lastLine(r.fix()), "ATTENTION: the fix round made no commits, so its findings stand");
  assert.match(r.calls()[1].stdin, /verify --full is red at \w{7}, red_cause introduced/, "the resumed child is told what the last round left red");
  assert.equal(r.run("round", "review").stdout.trim(), "OK review round 2/2: the last attempt made no commits, so it cost no round");
});
