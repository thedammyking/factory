// run-state.test.mjs — run-state.mjs spawned as a process against a throwaway project.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { project, sh, write, bareRemote } from "./harness.mjs";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugin/scripts/run-state.mjs");
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/spend");
const TODAY = new Date().toISOString().slice(0, 10);
const git = (cwd, ...args) => sh(cwd, "git", args);
// Spend is read from Claude Code's transcripts under CLAUDE_CONFIG_DIR, so no test reads the real ~/.claude.
const ENV = { ...process.env, CLAUDE_CODE_SESSION_ID: "s-1", CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "factory-claude-")) };
const rs = (cwd, args, input = "", env = ENV) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, input, encoding: "utf8", env });
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
const logLines = (p) => p.git("show", "factory/records:.factory/log.md").split("\n").map((l) => l.replace(/^- \S+ /, ""));
// A post-commit hook that moves main by an empty commit after each of the next `times` commits, the way a human or
// another run committing to the base between a snapshot's commit and its move would.
const baseMovesAfterCommit = (p, times) => {
  const counter = path.join(p.dir, ".git", "moves");
  fs.writeFileSync(path.join(p.dir, ".git", "hooks", "post-commit"), `#!/bin/sh
n=$(cat "${counter}" 2>/dev/null || echo 0)
[ "$n" -ge ${times} ] && exit 0
echo $((n + 1)) > "${counter}"
git update-ref refs/heads/factory/records "$(git commit-tree 'factory/records^{tree}' -p factory/records -m "base moved $n")"
`, { mode: 0o755 });
};
const tempWorktrees = (p) => p.git("worktree", "list", "--porcelain").split("\n").filter((l) => /^worktree .*\/\.base-/.test(l));
// The developer's env files: .factory/env.local, plus .env* files the main checkout ignores (through .git/info/exclude, so
// the checkout stays clean).
const envFiles = (p, files) => {
  fs.appendFileSync(path.join(p.dir, ".git/info/exclude"), ".env*\n");
  for (const [file, lines] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(p.dir, file)), { recursive: true });
    fs.writeFileSync(path.join(p.dir, file), lines.join("\n") + "\n");
  }
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

test("a new run starts from origin's tip when the local base is behind it, or has parted from it by the factory's own .factory/ commits alone; never past the developer's own (#81)", () => {
  const p = project(), remote = bareRemote(p);
  const elsewhere = (files, message) => {  // a commit that reaches origin from another clone, as a merged PR does
    const c = fs.mkdtempSync(path.join(os.tmpdir(), "factory-clone-"));
    sh(c, "git", ["clone", "-q", remote, "."]); sh(c, "git", ["config", "user.email", "x@x"]); sh(c, "git", ["config", "user.name", "x"]);
    write(c, files); sh(c, "git", ["add", "-A"]); sh(c, "git", ["commit", "-qm", message]); sh(c, "git", ["push", "-q", "origin", "main"]);
  };
  const commitHere = (files, message) => { write(p.dir, files); p.git("add", "-A"); p.git("commit", "-qm", message); };
  elsewhere({ "src/a.js": "1\n" }, "a merged PR");
  p.git("fetch", "-q", "origin");
  assert.equal(init(p, "First").base_sha, p.git("rev-parse", "origin/main"), "behind: origin's");
  commitHere({ ".factory/history/old/state.json": "{}\n" }, "factory(run): old snapshot");
  elsewhere({ "src/b.js": "2\n" }, "another merged PR");
  p.git("fetch", "-q", "origin");
  assert.equal(init(p, "Second").base_sha, p.git("rev-parse", "origin/main"), "parted by a snapshot alone: origin's");
  commitHere({ "src/mine.js": "3\n" }, "the developer's own");
  assert.equal(init(p, "Third").base_sha, p.git("rev-parse", "main"), "a product commit of the developer's: their main");
});

test("fix 24: snapshot commits the run dir to .factory/history/<run>/ on factory/records, never the base, and adds only new log lines", () => {
  const p = project();
  const s = init(p);
  const run = (...args) => rs(p.dir, [...args, "--run", s.id]);
  run("set", "stage", "needs-human");
  const first = run("snapshot");
  assert.equal(first.status, 0, first.stderr);
  const tracked = p.git("ls-tree", "-r", "--name-only", "factory/records", ".factory").split("\n");
  assert.doesNotMatch(p.git("ls-tree", "-r", "--name-only", "main"), /\.factory\/history\//, "main gets nothing but through a PR (#81)");
  for (const f of ["prompt.md", "state.json", "run.log"]) assert.ok(tracked.includes(`.factory/history/${s.id}/${f}`), f);
  assert.ok(!tracked.some((f) => f.startsWith(".factory/runs/")), "the run dir's own path is never tracked");
  run("set", "stage", "failed");
  assert.equal(run("snapshot").status, 0);
  assert.deepEqual(logLines(p), [`run: ${s.id} started`, `run: ${s.id} needs-human`, `run: ${s.id} failed`]);
  assert.equal(JSON.parse(p.git("show", `factory/records:.factory/history/${s.id}/state.json`)).stage, "failed", "a second snapshot refreshes the copy");
  assert.equal(p.git("status", "--porcelain"), "", "the main checkout is untouched");
});

test("snapshot applies again on a records branch that moved, and lands on the third try", () => {
  const p = project();
  const s = init(p);
  p.git("switch", "-q", "-c", "elsewhere");  // main is checked out nowhere, so it moves by compare-and-swap
  baseMovesAfterCommit(p, 2);
  const r = rs(p.dir, ["snapshot", "--run", s.id]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(p.git("log", "--format=%s", "factory/records").split("\n"),
    [`factory(run): ${s.id} snapshot (start)`, "base moved 1", "base moved 0", "init"]);
  assert.deepEqual(logLines(p), [`run: ${s.id} started`]);
  assert.deepEqual(tempWorktrees(p), []);
});

test("a records branch that moves on all 3 tries raises an attention item, ends the run needs-human and keeps its worktree", () => {
  const p = project();
  const s = init(p);
  rs(p.dir, ["set", "stage", "answered", "--run", s.id]);
  baseMovesAfterCommit(p, 3);
  const r = rs(p.dir, ["snapshot", "--run", s.id]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout.trim(), `needs-human: ${path.join(s.run_dir, "attention-snapshot.md")}`);
  assert.match(fs.readFileSync(path.join(s.run_dir, "attention-snapshot.md"), "utf8"), /^# .+\n\nRun `[^`]+`, stage `snapshot`\.\n\n## What happened\n/);
  assert.equal(JSON.parse(rs(p.dir, ["get", "--run", s.id]).stdout).stage, "needs-human");
  assert.ok(fs.existsSync(s.worktree));
  assert.deepEqual(tempWorktrees(p), []);
  assert.doesNotMatch(p.git("log", "--format=%s", "factory/records"), /snapshot/);
  assert.equal(p.git("status", "--porcelain"), "");
});

test("after its snapshot a run's worktree is removed on delivered, abandoned and answered, and kept on needs-human and failed", () => {
  const p = project();
  for (const [outcome, removed] of [["delivered", true], ["abandoned", true], ["answered", true], ["needs-human", false], ["failed", false]]) {
    const s = init(p, `Ask about ${outcome}`);
    rs(p.dir, outcome === "abandoned" ? ["abandon", "--run", s.id] : ["set", "stage", outcome, "--run", s.id]);
    const r = rs(p.dir, ["snapshot", "--run", s.id]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(s.worktree), !removed, outcome);
    assert.equal(p.git("worktree", "list").includes(s.worktree), !removed, outcome);
  }
  const s = init(p, "Ask about uncommitted work");
  fs.writeFileSync(path.join(s.worktree, "notes.txt"), "work in progress\n");
  rs(p.dir, ["set", "stage", "delivered", "--run", s.id]);
  const r = rs(p.dir, ["snapshot", "--run", s.id]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /worktree kept/);
  assert.ok(fs.existsSync(path.join(s.worktree, "notes.txt")), "a worktree holding uncommitted work is never removed");
});

test("an answered run can't be resumed: once its worktree is gone, every command says it has ended and where its record is", () => {
  const p = project();
  const s = init(p, "Where is the session timeout set?");
  rs(p.dir, ["set", "stage", "answered", "--run", s.id]);
  assert.equal(rs(p.dir, ["snapshot", "--run", s.id]).status, 0);
  for (const args of [["get"], ["dispatch", "triage"], ["set", "stage", "needs-human"]]) {
    const r = rs(p.dir, [...args, "--run", s.id]);
    assert.equal(r.status, 2, args[0]);
    assert.equal(r.stderr.trim(), `run ${s.id} has ended answered: its record is .factory/history/${s.id}/ on factory/records`);
  }
});

test("the secret check refuses a run file holding a credential from the env files, naming where it lives, never its value", () => {
  const p = project();
  envFiles(p, {
    ".factory/env.local": ["STRIPE_SECRET_KEY=sk_test_51Habcdef", "WEBHOOK_AUTH_URL=http://localhost:4000/hook?token=whk_9f8e7d6c"],
    "apps/api/.env.local": ["# the API's database", "export DATABASE_URL='postgres://app:hunter2hunter2@db.internal:5432/app'"],
  });
  for (const [leak, name, file] of [
    ["sk_test_51Habcdef", "STRIPE_SECRET_KEY", ".factory/env.local"],
    ["http://localhost:4000/hook?token=whk_9f8e7d6c", "WEBHOOK_AUTH_URL", ".factory/env.local"],
    ["hunter2hunter2", "DATABASE_URL", "apps/api/.env.local"],
  ]) {
    const s = init(p);
    rs(p.dir, ["set", "stage", "answered", "--run", s.id]);
    fs.writeFileSync(path.join(s.run_dir, "answer.md"), `# Which key?\n\nThis one: ${leak}.\n`);
    const r = rs(p.dir, ["snapshot", "--run", s.id]);
    assert.equal(r.status, 1, name);
    const item = fs.readFileSync(path.join(s.run_dir, "attention-secret.md"), "utf8");
    assert.match(item, new RegExp(`\`answer\\.md\` holds the value of \`${name}\` from \`${file.replace(".", "\\.")}\``));
    assert.ok(![r.stdout, r.stderr, item].some((out) => out.includes(leak)), "the check never prints the value");
    assert.equal(JSON.parse(rs(p.dir, ["get", "--run", s.id]).stdout).stage, "needs-human");
    assert.ok(fs.existsSync(s.worktree));
  }
  assert.doesNotMatch(p.git("log", "--format=%s", "main"), /snapshot/, "nothing is committed");
});

test("the secret check lets plain settings through: localhost URLs, short values and names that aren't credential-like", () => {
  const p = project();
  envFiles(p, { ".env": [
    "NEXTAUTH_URL=http://localhost:3000",
    "DATABASE_URL=postgres://localhost:5432/app",
    "REDIS_URL=redis://app:pw@localhost:6379",
    "API_TOKEN=abc1234",
    "APP_NAME=reporting-dashboard",
  ] });
  const s = init(p);
  rs(p.dir, ["set", "stage", "answered", "--run", s.id]);
  fs.writeFileSync(path.join(s.run_dir, "answer.md"),
    "It serves http://localhost:3000, reads postgres://localhost:5432/app and redis://app:pw@localhost:6379, as reporting-dashboard with abc1234.\n");
  const r = rs(p.dir, ["snapshot", "--run", s.id]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(p.git("ls-tree", "-r", "--name-only", "factory/records"), new RegExp(`\\.factory/history/${s.id}/answer\\.md`));
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

// A Claude config dir laid out as Claude Code writes it: the orchestrator session's transcript, and each of its subagents'
// under <session>/subagents/. Fixtures are trimmed copies of real transcripts (see docs/platform-facts.md); every line is
// stamped `at`, by default now, so it falls inside the run. `usage(id, tokens)` is one synthetic assistant message.
function claude() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "factory-claude-")));
  const folder = path.join(dir, "projects", "-any-project");  // named after the session's cwd; run-state finds it by session id
  const put = (file, lines, at = new Date().toISOString()) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, lines.map((e) => JSON.stringify(e.timestamp ? { ...e, timestamp: at } : e) + "\n").join(""));
  };
  const read = (fixture) => fs.readFileSync(path.join(FIXTURES, fixture), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const lines = (src) => (typeof src === "string" ? read(src) : src);
  return {
    env: { ...ENV, CLAUDE_CONFIG_DIR: dir },
    orchestrator: (src, at, session = "s-1") => put(path.join(folder, `${session}.jsonl`), lines(src), at),
    subagent: (id, src, session = "s-1") => put(path.join(folder, session, "subagents", `agent-${id}.jsonl`), lines(src)),
    // a child's stream-json log, which run-stage keeps in the run dir
    child: (s, name, fixture) => { const f = path.join(s.run_dir, "logs", name); put(f, read(fixture)); return f; },
  };
}
const usage = (id, tokens) => [{ type: "assistant", timestamp: "now", message: { role: "assistant", id, model: "claude-sonnet-5-5",
  usage: { input_tokens: 0, cache_creation_input_tokens: tokens, cache_read_input_tokens: 0, output_tokens: 0 }, content: [] } }];
const stateOf = (p, s, env) => JSON.parse(rs(p.dir, ["get", "--run", s.id], "", env).stdout);

test("spend sums usage over the orchestrator's and each subagent's transcript, once per message, labelled an estimate", () => {
  const p = project();
  const c = claude();
  const s = init(p);
  const run = (...args) => rs(p.dir, [...args, "--run", s.id], "", c.env);
  run("dispatch", "triage");
  run("dispatch", "triage", "--agent", "a7ce2506451053844");
  run("dispatch", "research");
  run("dispatch", "research", "--agent", "a0be9c5b71ddc5663");
  c.orchestrator("orchestrator.jsonl");
  c.subagent("a7ce2506451053844", "subagent.jsonl");
  c.subagent("a0be9c5b71ddc5663", "subagent-compacted.jsonl");  // a subagent that compacted three times
  const r = run("spend");
  assert.equal(r.status, 0, r.stderr);
  const spend = stateOf(p, s, c.env).spend;
  // The orchestrator and triage are one real session, whose own final result (child-round1.stream.jsonl) is 49845.
  assert.equal(spend.by_stage.orchestrator.tokens + spend.by_stage.triage.tokens, 49845);
  assert.equal(spend.tokens, 49845 + 81544);
  assert.deepEqual(spend.by_stage, {
    orchestrator: { tokens: 36923, tool_chars: { Agent: 748, Read: 24 }, images: 0, compactions: 1, estimate: true },
    triage: { tokens: 12922, tool_chars: { Read: 24, Bash: 151 }, images: 1, compactions: 0, estimate: true },
    research: { tokens: 81544, tool_chars: { Read: 5000 }, images: 0, compactions: 3, estimate: true },
  });
  assert.match(r.stdout, /^tokens 131389\/1500000$/m);
  assert.match(r.stdout, /^ {2}triage: 12922 tokens \(estimate\); tool results Read 24, Bash 151 chars; 1 images; 0 compactions$/m);
  const number = run("spend", "12000");
  assert.equal(number.status, 2);
  assert.match(number.stderr, /spend takes no number/);
});

test("a child is measured from the per-model usage in its final result, and a child resumed for round 2 is counted once", () => {
  const p = project();
  const c = claude();
  const s = init(p);
  const run = (...args) => rs(p.dir, [...args, "--run", s.id], "", c.env);
  // Round 1, then round 2 resumes the same child session, which compacts (a manual /compact here).
  for (const [round, fixture] of [[1, "child-round1.stream.jsonl"], [2, "child-round2.stream.jsonl"]]) {
    assert.equal(run("dispatch", "implement").status, 0);
    assert.equal(run("dispatch", "implement", "--log", c.child(s, `implement-${round}.stream.jsonl`, fixture)).status, 0);
  }
  const st = stateOf(p, s, c.env);
  assert.deepEqual(st.dispatches.map((d) => path.basename(d.log)), ["implement-1.stream.jsonl", "implement-2.stream.jsonl"]);
  run("spend");
  // Round 2's result is the session's total, round 1's 49845 included: 49845 + the compaction's 4263.
  assert.deepEqual(stateOf(p, s, c.env).spend.by_stage, {
    implement: { tokens: 54108, tool_chars: { Agent: 748, Read: 48, Bash: 151 }, images: 1, compactions: 1 },
  });
});

// Moves the run's clock back by `minutes`, as if that long had passed since it started (and since it began waiting).
const age = (s, minutes) => {
  const file = path.join(s.run_dir, "state.json"), st = JSON.parse(fs.readFileSync(file, "utf8"));
  const back = (at) => at && new Date(Date.parse(at) - minutes * 60000).toISOString();
  fs.writeFileSync(file, JSON.stringify({ ...st, created_at: back(st.created_at), waiting_since: back(st.waiting_since) }));
};

test("budgets are checked only between dispatches: a stage that crosses a cap finishes, and the next dispatch is refused with BUDGET and a breakdown", () => {
  const p = project({ config: { caps: { tokens_per_run: 40000 } } });
  const c = claude();
  const s = init(p);
  const run = (...args) => rs(p.dir, [...args, "--run", s.id], "", c.env);
  assert.equal(run("dispatch", "triage").status, 0);
  c.orchestrator("orchestrator.jsonl");  // 36923, past 70% of 40000
  const attach = run("dispatch", "triage", "--agent", "a7ce2506451053844");
  assert.equal(attach.status, 0);
  assert.doesNotMatch(attach.stdout, /WARN|BUDGET/, "attaching the agent id is the same dispatch");
  assert.equal(run("done", "triage").status, 0);
  const answer = run("dispatch", "answer");
  assert.equal(answer.status, 0, answer.stderr);
  assert.match(answer.stdout, /^WARN 70% of the tokens cap: 36923\/40000$/m);
  c.subagent("a7ce2506451053844", "subagent.jsonl");  // the triager's 12922 lands after its stage was dispatched
  const again = run("dispatch", "answer");
  assert.equal(again.status, 4);
  assert.deepEqual(again.stdout.trim().split("\n"), [
    "BUDGET tokens 49845/40000: answer not dispatched",
    "  orchestrator: 36923 tokens (estimate); tool results Read 24, Agent 748 chars; 0 images; 1 compactions",
    "  triage: 12922 tokens (estimate); tool results Read 24, Bash 151 chars; 1 images; 0 compactions",
  ], "each 70% warning fires once");
  assert.deepEqual(stateOf(p, s, c.env).dispatches.map((d) => d.stage), ["triage", "answer"], "a refused dispatch is never recorded");
});

test("the dispatch cap refuses the 31st dispatch and the minute cap refuses past 90 minutes, each warning once at 70%", () => {
  const p = project();
  const s = init(p);
  const outs = Array.from({ length: 31 }, (_, i) => rs(p.dir, ["dispatch", `stage-${i + 1}`, "--run", s.id]));
  assert.deepEqual(outs.slice(0, 30).map((r) => r.status), Array(30).fill(0));
  assert.deepEqual(outs.flatMap((r) => r.stdout.match(/^WARN 70% of the dispatches.*$/gm) || []), ["WARN 70% of the dispatches cap: 21/30"]);
  assert.match(outs[21].stdout, /^WARN 70% of the dispatches cap: 21\/30$/m, "on the 22nd");
  assert.equal(outs[30].status, 4);
  assert.match(outs[30].stdout, /^BUDGET dispatches 30\/30: stage-31 not dispatched$/m);
  const m = init(p, "Fix the login crash");
  const dispatch = () => rs(p.dir, ["dispatch", "triage", "--run", m.id]);
  age(m, 63);
  assert.match(dispatch().stdout, /^WARN 70% of the minutes cap: 63\/90$/m);
  assert.doesNotMatch(dispatch().stdout, /WARN 70%/);
  age(m, 28);  // 91 in all
  const late = dispatch();
  assert.equal(late.status, 4);
  assert.match(late.stdout, /^BUDGET minutes 91\/90: triage not dispatched$/m);
  // A run waiting on the human isn't running: a hold answered the next morning triages again under the cap.
  const held = init(p, "Make the export faster");
  rs(p.dir, ["dispatch", "triage", "--run", held.id]);
  rs(p.dir, ["set", "stage", "needs-human", "--run", held.id]);
  age(held, 600);
  const again = rs(p.dir, ["dispatch", "triage", "--run", held.id]);
  assert.equal(again.status, 0, again.stdout);
  assert.match(rs(p.dir, ["spend", "--run", held.id]).stdout, /^minutes 0\/90$/m);
});

test("a fact the grill sends for counts toward the build run's caps and spend, repeats, and leaves research.md in place", () => {
  const p = project({ config: { caps: { dispatches_per_run: 3 } } });
  const c = claude();
  const s = init(p);
  const run = (...args) => rs(p.dir, [...args, "--run", s.id], "", c.env);
  const research = path.join(s.run_dir, "research.md");
  run("set", "route", "build");
  run("dispatch", "research");
  fs.writeFileSync(research, "# Research: a CSV export\n\nStatus: ok\n");
  run("done", "research");
  const fact = run("dispatch", "fact");
  assert.equal(fact.status, 0, fact.stderr || fact.stdout);
  assert.equal(run("dispatch", "fact", "--agent", "a-fact").status, 0);
  c.subagent("a-fact", usage("m-fact", 5000));
  fs.appendFileSync(research, "\n## Fact: How big may an export be?\n\n- Unknown: no limit is set.\n");
  assert.equal(run("done", "fact").status, 0);
  assert.equal(run("dispatch", "fact").status, 0, "a second fact in the same grill");
  let st = stateOf(p, s, c.env);
  assert.deepEqual(st.dispatches.map((d) => d.stage), ["research", "fact", "fact"]);
  assert.equal(st.spend.by_stage.fact.tokens, 5000);
  assert.ok(!st.stages_done.includes("fact"), "the second fact is working");
  assert.match(fs.readFileSync(research, "utf8"), /^Status: ok\n\n## Fact: How big may an export be\?/m, "research.md is never moved aside");
  assert.deepEqual(fs.readdirSync(s.run_dir).filter((f) => f.startsWith("research")), ["research.md"]);
  const over = run("dispatch", "fact");
  assert.equal(over.status, 4);
  assert.match(over.stdout, /^BUDGET dispatches 3\/3: fact not dispatched$/m);
  st = stateOf(p, s, c.env);
  assert.equal(st.dispatches.length, 3, "a refused fact is never recorded");
});

test("a run resumed in another session is measured in both: each dispatch records the session it was made from", () => {
  const p = project();
  const c = claude();
  const s = init(p);
  const as2 = { ...c.env, CLAUDE_CODE_SESSION_ID: "s-2" };
  rs(p.dir, ["dispatch", "triage", "--run", s.id], "", c.env);
  c.orchestrator(usage("m-1", 1000));
  rs(p.dir, ["dispatch", "triage", "--run", s.id], "", as2);
  rs(p.dir, ["dispatch", "triage", "--agent", "a-2", "--run", s.id], "", as2);
  c.orchestrator(usage("m-2", 2000), undefined, "s-2");
  c.subagent("a-2", usage("m-3", 4000), "s-2");
  rs(p.dir, ["spend", "--run", s.id], "", as2);
  assert.deepEqual(Object.fromEntries(Object.entries(stateOf(p, s, c.env).spend.by_stage).map(([k, x]) => [k, x.tokens])),
    { orchestrator: 3000, triage: 4000 });
});

// Dispatches `stage` with a subagent that then spends `tokens`; returns the dispatch's output.
const stageSpending = (p, s, c, stage, tokens) => {
  const r = rs(p.dir, ["dispatch", stage, "--run", s.id], "", c.env);
  assert.equal(rs(p.dir, ["dispatch", stage, "--agent", `a-${stage}`, "--run", s.id], "", c.env).status, 0);
  c.subagent(`a-${stage}`, usage(`m-${stage}`, tokens));
  return r;
};
const tickets = (s, n) => {
  fs.mkdirSync(path.join(s.run_dir, "tickets"), { recursive: true });
  for (let i = 1; i <= n; i++) fs.writeFileSync(path.join(s.run_dir, "tickets", `0${i}-slice-${i}.md`), "Status: ready-for-agent\n");
};

test("fix 7: the token and minute caps scale with the ticket count, so a four-ticket run's 3.33M never stops it", () => {
  const p = project();
  const c = claude();
  const s = init(p);
  const out = [];
  for (const [stage, tokens] of [["triage", 150000], ["research", 250000], ["spec", 200000], ["tickets", 100000]]) out.push(stageSpending(p, s, c, stage, tokens));
  tickets(s, 4);
  for (const n of ["01", "02", "03", "04"]) out.push(stageSpending(p, s, c, `implement:${n}`, 500000));
  for (const [stage, tokens] of [["review", 400000], ["pr", 230000]]) out.push(stageSpending(p, s, c, stage, tokens));
  out.push(rs(p.dir, ["dispatch", "ci", "--run", s.id], "", c.env));
  assert.deepEqual(out.map((r) => r.status), Array(11).fill(0), "no cap fires");
  // 700k + 700k x 4 = 3.5M: the warning comes at 2.45M, once the four tickets are built, at the review's dispatch.
  assert.deepEqual(out.map((r) => r.stdout.match(/^WARN 70% of the tokens.*$/m)?.[0]).filter(Boolean), ["WARN 70% of the tokens cap: 2700000/3500000"]);
  assert.match(out[8].stdout, /WARN 70% of the tokens cap/);
  const spend = rs(p.dir, ["spend", "--run", s.id], "", c.env).stdout;
  assert.match(spend, /^tokens 3330000\/3500000$/m);
  assert.match(spend, /^minutes \d+\/225$/m, "90 + 45 per ticket beyond the first");
  // Before the ticket count is known, the cap is tokens_per_run; once it scales, its 70% warning can come again.
  const early = init(p, "Fix the login crash");
  stageSpending(p, early, c, "triage", 1100000);
  assert.match(stageSpending(p, early, c, "research", 500000).stdout, /^WARN 70% of the tokens cap: 1100000\/1500000$/m);
  assert.match(rs(p.dir, ["dispatch", "spec", "--run", early.id], "", c.env).stdout, /^BUDGET tokens 1600000\/1500000: spec not dispatched$/m);
  tickets(early, 2);
  assert.match(rs(p.dir, ["dispatch", "spec", "--run", early.id], "", c.env).stdout, /^WARN 70% of the tokens cap: 1600000\/2100000$/m);
});

test("fix 13: once pr.json exists, spend goes to its own 400k allowance with its own warning, which a tokens override doesn't lift", () => {
  const p = project();
  const c = claude();
  const s = init(p);
  const run = (...args) => rs(p.dir, [...args, "--run", s.id], "", c.env);
  stageSpending(p, s, c, "build", 1000000);
  fs.writeFileSync(path.join(s.run_dir, "pr.json"), '{"number":7}\n');
  const first = stageSpending(p, s, c, "fix-1", 300000);
  assert.equal(first.status, 0);
  assert.doesNotMatch(first.stdout, /WARN|BUDGET/, "the build's million is the tokens cap's, not the allowance's");
  const second = stageSpending(p, s, c, "fix-2", 210000);
  assert.match(second.stdout, /^WARN 70% of the post_pr cap: 300000\/400000$/m);
  const third = run("dispatch", "fix-3");
  assert.equal(third.status, 4);
  assert.match(third.stdout, /^BUDGET post_pr 510000\/400000: fix-3 not dispatched$/m);
  assert.match(run("spend").stdout, /^tokens 1000000\/1500000\npost_pr 510000\/400000$/m);
  assert.equal(run("override", "tokens", "the build ran long").status, 0);
  assert.equal(run("dispatch", "fix-3").status, 4, "a tokens override doesn't lift the post-PR allowance");
  assert.equal(run("override", "post_pr", "one more review round is worth it").status, 0);
  assert.equal(run("dispatch", "fix-3").status, 0);
});

test("fix 12: override records who lifted which cap and why, later checks honour it, and the run can't end delivered", () => {
  const p = project({ config: { caps: { tokens_per_run: 40000 } } });
  const c = claude();
  const s = init(p);
  const run = (...args) => rs(p.dir, [...args, "--run", s.id], "", c.env);
  run("dispatch", "triage");
  run("dispatch", "triage", "--agent", "a7ce2506451053844");
  c.orchestrator("orchestrator.jsonl");
  c.subagent("a7ce2506451053844", "subagent.jsonl");
  age(s, 91);
  const refused = run("dispatch", "answer");
  assert.equal(refused.status, 4);
  assert.deepEqual(refused.stdout.match(/^BUDGET .*$/gm), ["BUDGET tokens 49845/40000: answer not dispatched"], "with its tokens read, the minutes only warn (#81)");
  assert.match(refused.stdout, /^WARN minutes 91\/90: past the minute cap, which stops a run only when its tokens can't be read$/m);
  assert.equal(run("override", "tokens").status, 2, "an override needs a reason");
  assert.equal(run("override", "budget", "why not").status, 2, "and a cap");
  const minutes = run("override", "minutes", "the spec grew");
  assert.equal(minutes.status, 0, minutes.stderr);
  const still = run("dispatch", "answer").stdout;
  assert.deepEqual(still.match(/^BUDGET .*$/gm), ["BUDGET tokens 49845/40000: answer not dispatched"]);
  assert.doesNotMatch(still, /WARN minutes/, "lifted, it stops warning");
  run("override", "tokens", "the spec grew");
  for (const stage of ["answer", "review", "pr", "ci"]) assert.equal(run("dispatch", stage).status, 0, stage);
  const st = stateOf(p, s, c.env);
  assert.deepEqual(st.dispatches.map((d) => d.stage), ["triage", "answer", "review", "pr", "ci"], "the refused dispatches are recorded once lifted");
  assert.deepEqual(Object.keys(st.overrides), ["minutes", "tokens"]);
  assert.deepEqual([st.overrides.tokens.by, st.overrides.tokens.reason], ["t", "the spec grew"], "who (the git user) and why");
  assert.match(fs.readFileSync(path.join(s.run_dir, "run.log"), "utf8"), /override tokens by t: the spec grew/);
  assert.match(run("spend").stdout, /^tokens 49845\/40000 \(lifted\)$/m);
  const end = run("set", "stage", "delivered");
  assert.equal(end.status, 0, end.stderr);
  assert.match(end.stdout, /overrode minutes, tokens/);
  assert.equal(stateOf(p, s, c.env).stage, "needs-human");
});

test("the attribution lines: a factory commit ends with the commit lines the session recorded, an export wins, and with neither it goes without them and says so once", () => {
  const p = project();
  const s = init(p);
  const env = { ...ENV };
  delete env.FACTORY_COMMIT_TRAILER; delete env.FACTORY_PR_TRAILER;
  const run = (args, e = env) => rs(p.dir, [...args, "--run", s.id], "", e);
  const snapshot = (stage, e) => { run(["set", "stage", stage]); const r = run(["snapshot"], e); assert.equal(r.status, 0, r.stderr); return r; };
  const message = () => p.git("log", "-1", "--format=%B", "factory/records");
  const none = snapshot("needs-human");
  assert.equal(message(), `factory(run): ${s.id} snapshot (needs-human)`, "none recorded: the commit goes without");
  assert.equal(none.stderr.match(/no attribution recorded/g)?.length, 1, none.stderr);
  assert.equal(run(["set", "attribution", "Co-Authored-By: A <a@a>"]).status, 2, "a pair, as JSON");
  assert.equal(run(["set", "attribution", '{"commit":"Co-Authored-By: A <a@a>"}']).status, 2, "both lines");
  assert.equal(run(["set", "attribution", JSON.stringify({ commit: "Co-Authored-By: A <a@a>\nReviewed-by: B", pr: "Made with A" })]).status, 0);
  assert.equal(snapshot("failed").stderr, "");
  assert.equal(message(), `factory(run): ${s.id} snapshot (failed)\n\nCo-Authored-By: A <a@a>\nReviewed-by: B`, "from state");
  snapshot("needs-human", { ...env, FACTORY_COMMIT_TRAILER: "Co-Authored-By: C <c@c>" });
  assert.equal(message(), `factory(run): ${s.id} snapshot (needs-human)\n\nCo-Authored-By: C <c@c>`, "an export wins");
  run(["set", "attribution", '{"commit":"","pr":""}']);
  assert.equal(snapshot("failed").stderr, "", "an empty pair is a session that wants none");
  assert.equal(message(), `factory(run): ${s.id} snapshot (failed)`);
});

test("when the parser reads nothing it warns once, in the session and in status, and the run goes on under the minute and dispatch caps", () => {
  const p = project({ config: { caps: { tokens_per_run: 1 } } });
  const c = claude();
  const s = init(p);
  c.orchestrator([  // a transcript in shapes the parser doesn't know
    { type: "turn", timestamp: "now", tokens: 5000 },
    { type: "result", modelUsage: { "claude-sonnet-5-5": null } },
    { type: "user", message: { content: [{ type: "tool_result", content: { text: "x" } }] } },
  ]);
  fs.appendFileSync(path.join(c.env.CLAUDE_CONFIG_DIR, "projects", "-any-project", "s-1.jsonl"), "not json\n");
  const dispatch = () => rs(p.dir, ["dispatch", "triage", "--run", s.id], "", c.env);
  const first = dispatch();
  assert.equal(first.status, 0);
  assert.match(first.stdout, /^WARN spend: no usage read from any transcript, so only the minute and dispatch caps apply$/m);
  assert.doesNotMatch(dispatch().stdout, /WARN/);
  assert.match(rs(p.dir, ["status"], "", c.env).stdout, new RegExp(`^${s.id}\\s.*  spend unread: only the minute and dispatch caps apply$`, "m"));
  age(s, 91);
  assert.match(dispatch().stdout, /^BUDGET minutes 91\/90/m);
});

test("the orchestrator's messages from before the run started aren't the run's", () => {
  const p = project();
  const c = claude();
  const s = init(p);
  c.orchestrator("orchestrator.jsonl", "2000-01-01T00:00:00.000Z");
  c.orchestrator(usage("m-now", 5000));
  rs(p.dir, ["spend", "--run", s.id], "", c.env);
  assert.equal(stateOf(p, s, c.env).spend.by_stage.orchestrator.tokens, 5000);
});

test("allow adds a rule to the run worktree's .claude/settings.json and commits it on the run branch, once, and logs it, keeping the rest of the file", () => {
  const p = project();
  const s = init(p);
  git(s.worktree, "switch", "-q", "-c", "feature/csv-export");
  const recipe = path.join(s.worktree, ".claude/settings.json");
  fs.mkdirSync(path.dirname(recipe), { recursive: true });
  fs.writeFileSync(recipe, JSON.stringify({ env: { CI: "1" }, permissions: { allow: ["Bash(make:*)"], deny: ["Bash(rm:*)"] } }));
  git(s.worktree, "add", ".claude"); git(s.worktree, "commit", "-qm", "The project's settings");
  const head = git(s.worktree, "rev-parse", "HEAD");
  const allow = (rule) => rs(p.dir, ["allow", rule, "--run", s.id]);
  const first = allow("Bash(docker compose up:*)");
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout.trim(), "allowed Bash(docker compose up:*), committed on feature/csv-export");
  assert.deepEqual(JSON.parse(fs.readFileSync(recipe, "utf8")), { env: { CI: "1" }, permissions: { allow: ["Bash(make:*)", "Bash(docker compose up:*)"], deny: ["Bash(rm:*)"] } });
  assert.equal(git(s.worktree, "rev-parse", "HEAD~1"), head, "one commit on the run branch");
  assert.deepEqual(git(s.worktree, "show", "--name-only", "--format=", "HEAD").split("\n"), [".claude/settings.json"]);
  assert.equal(git(s.worktree, "status", "--porcelain"), "");
  assert.match(fs.readFileSync(path.join(s.run_dir, "run.log"), "utf8"), /run: \S+ allowed Bash\(docker compose up:\*\)\n/);
  const text = fs.readFileSync(recipe, "utf8"), commit = git(s.worktree, "rev-parse", "HEAD");
  const again = allow("Bash(docker compose up:*)");
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout.trim(), "allowed already: Bash(docker compose up:*)");
  assert.deepEqual([fs.readFileSync(recipe, "utf8"), git(s.worktree, "rev-parse", "HEAD")], [text, commit], "a second allow of the same rule changes nothing");
  assert.equal(allow("Bash(npm publish)").status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(recipe, "utf8")).permissions.allow, ["Bash(make:*)", "Bash(docker compose up:*)", "Bash(npm publish)"]);
});

test("allow refuses a rule that would allow every command, one without a program, and anything that isn't one well-formed Bash rule", () => {
  const p = project();
  const s = init(p);
  git(s.worktree, "switch", "-q", "-c", "feature/csv-export");
  const recipe = path.join(s.worktree, ".claude/settings.json"), head = git(s.worktree, "rev-parse", "HEAD");
  for (const rule of ["Bash", "Bash(*)", "Bash(:*)", "Bash( :*)", "Bash()", "Bash(* install:*)", "Bash(np*:*)",  // no program
    "Bash(sh -c:*)", "Bash(bash:*)", "Bash(/bin/zsh:*)", "Bash(busybox sh:*)", "Bash(env:*)", "Bash(sudo npm:*)", "Bash(xargs:*)",  // a program that runs any other
    "Read(*)", "Edit(/**)", "npm install", "bash(npm install:*)", "Bash(npm install:*),Bash(*)", "Bash(npm install:*) Bash(*)", "Bash(npm (x):*)", "Bash(npm install:*)\nBash(*)", ""]) {
    const r = rs(p.dir, ["allow", rule, "--run", s.id]);
    assert.equal(r.status, 2, JSON.stringify(rule));
    assert.match(r.stderr, /run-state: allow takes one Bash rule that names the program it runs/, JSON.stringify(rule));
  }
  assert.deepEqual([fs.existsSync(recipe), git(s.worktree, "rev-parse", "HEAD")], [false, head], "nothing was written or committed");
  assert.doesNotMatch(fs.readFileSync(path.join(s.run_dir, "run.log"), "utf8"), /allowed/);
  fs.mkdirSync(path.dirname(recipe), { recursive: true });
  fs.writeFileSync(recipe, "{ \"permissions\": [");
  const broken = rs(p.dir, ["allow", "Bash(npm install:*)", "--run", s.id]);
  assert.equal(broken.status, 2);
  assert.match(broken.stderr, /settings\.json doesn't parse as JSON/);
  assert.equal(fs.readFileSync(recipe, "utf8"), "{ \"permissions\": [", "settings that don't parse are never written over");
});
