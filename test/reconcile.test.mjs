// reconcile.test.mjs — run-state.mjs reconcile, the protocol /factory resume runs, spawned as a process on a throwaway
// project. A cut-off implementer child, its salvage commit and its continuation are in run-stage.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { project } from "./harness.mjs";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugin/scripts/run-state.mjs");
// Claude Code's config dir, where a session's transcript is projects/<folder>/<session>.jsonl; never the real ~/.claude.
const CONFIG = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "factory-claude-")));
const rs = (cwd, args, { session = "s-1", input = "" } = {}) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd, input, encoding: "utf8", env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG, CLAUDE_CODE_SESSION_ID: session } });
// A run started by session s-1. run(args, session) runs a command on it as that session (s-1 by default).
function started() {
  const p = project();
  const r = rs(p.dir, ["init"], { input: "Add a CSV export to the reports page\n" });
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  const run = (args, session) => rs(p.dir, [...args, "--run", s.id], { session });
  return { p, s, run, state: () => JSON.parse(run(["get"]).stdout) };
}
// A subagent's transcript beside its session's, as Claude Code writes it, holding `lines`.
function subagent(id, lines, session = "s-1") {
  const folder = path.join(CONFIG, "projects", "-any-project"), file = path.join(folder, session, "subagents", `agent-${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(path.join(folder, `${session}.jsonl`))) fs.writeFileSync(path.join(folder, `${session}.jsonl`), "{}\n");
  fs.writeFileSync(file, lines.map((e) => JSON.stringify(e) + "\n").join(""));
}
const SPOKE = { type: "assistant", message: { id: "msg-1", role: "assistant", content: [{ type: "text", text: "Reading the repo." }] } };
// the transcript line Claude Code writes when a 429 ends a turn (docs/platform-facts.md, fact 13)
const LIMIT = { type: "assistant", error: "rate_limit", isApiErrorMessage: true, message: { id: "msg-2", model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "API Error: Request rejected (429)" }] } };

test("resuming a run another session owns shows that session's last activity and changes nothing until it's taken over", () => {
  const { s, run, state } = started();
  run(["dispatch", "triage"]);
  run(["dispatch", "triage", "--agent", "a-1"]);
  const transcript = path.join(CONFIG, "projects", "-any-project", "s-1.jsonl"), at = new Date("2026-11-03T21:15:00.000Z");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, "{}\n");
  fs.utimesSync(transcript, at, at);
  const files = () => ["state.json", "run.log"].map((f) => fs.readFileSync(path.join(s.run_dir, f), "utf8"));
  const before = files(), st = JSON.parse(before[0]);
  const asked = run(["reconcile"], "s-2");
  assert.equal(asked.status, 6, asked.stderr);
  assert.deepEqual(asked.stdout.trim().split("\n"), [
    `OWNED ${s.id}: session s-1 owns it, and this is session s-2`,
    `  the owner's last activity: 2026-11-03T21:15:00.000Z, its transcript's last write (${transcript})`,
    `  the run's last update: ${st.updated_at}, its last dispatch triage at ${st.dispatches[0].at}`,
    `  its last log line: ${before[1].trim().split("\n").at(-1).slice(2)}`,
    `Take it over only if that session is gone: node "${SCRIPT}" reconcile --take-over --run ${s.id}`,
  ]);
  assert.deepEqual(files(), before, "nothing changed");
  assert.doesNotMatch(run(["reconcile"]).stdout, /OWNED/, "the owner itself isn't asked");
  const took = run(["reconcile", "--take-over"], "s-2");
  assert.equal(took.status, 0, took.stderr);
  assert.match(took.stdout, /^taken over from session s-1$/m);
  const after = state();
  assert.deepEqual([after.session, after.taken_over.map((t) => t.from)], ["s-2", ["s-1"]]);
  assert.match(fs.readFileSync(path.join(s.run_dir, "run.log"), "utf8"), /run: \S+ reconciled, taken over from session s-1\n$/);
  assert.equal(run(["reconcile"], "s-2").status, 0, "the new owner isn't asked again");
});

test("reconcile skips the stages marked done and continues each one cut off: a subagent that left output by its agent id, any other afresh, a review always afresh", () => {
  const { s, run, state } = started();
  for (const [stage, agent] of [["triage", "a-1"], ["research", "a-2"], ["review-code", "a-3"], ["builder-check", "a-4"], ["spec"]]) {
    run(["dispatch", stage]);
    if (agent) run(["dispatch", stage, "--agent", agent]);
  }
  for (const id of ["a-1", "a-2", "a-3"]) subagent(id, [SPOKE]);  // a-4 was cut off before its first message
  fs.writeFileSync(path.join(s.run_dir, "triage.md"), "triaged\n");
  run(["done", "triage"]);
  const out = run(["reconcile"]);
  assert.equal(out.status, 0, out.stderr);
  const sha = s.base_sha.slice(0, 7), lines = (r) => r.stdout.split("\n").filter((l) => /^(done|CONTINUE)\b/.test(l));
  assert.deepEqual(lines(out), [
    "done: triage",
    `CONTINUE research from ${sha}: resume agent a-2`,
    `CONTINUE review-code from ${sha}: fresh, a cut-off review is re-run fresh, never resumed`,
    `CONTINUE builder-check from ${sha}: fresh`,
    `CONTINUE spec from ${sha}: fresh`,
  ]);
  assert.equal(fs.readFileSync(path.join(s.run_dir, "triage.md"), "utf8"), "triaged\n", "a done stage's output is left as it is");
  assert.equal(state().dispatches.length, 5, "reconcile dispatches nothing itself");
  run(["set", "stage", "failed"]);
  assert.match(lines(run(["reconcile"])).join("\n"), new RegExp(`^CONTINUE research from ${sha}: fresh, its output was judged incomplete$`, "m"), "a failed stage is run again, never resumed");
  run(["set", "stage", "needs-human"]);
  assert.doesNotMatch(run(["reconcile"]).stdout, /^CONTINUE/m, "a run stopped needs-human waits on its attention item, not on a stage");
});

test("a subagent that stopped at the usage limit leaves its run suspended, not failed, and is resumed by its agent id", () => {
  const { s, run, state } = started();
  run(["dispatch", "triage"]);
  run(["dispatch", "triage", "--agent", "a-9"]);
  subagent("a-9", [SPOKE, LIMIT]);
  const ended = run(["set", "stage", "failed"]);
  assert.equal(ended.status, 0, ended.stderr);
  assert.match(ended.stdout, /^triage stopped at the usage limit: the run is suspended, not failed$/m);
  assert.equal(state().stage, "suspended");
  assert.match(run(["status"]).stdout, new RegExp(`^${s.id}\\s+suspended\\s`, "m"));
  assert.match(run(["reconcile"]).stdout, new RegExp(`^CONTINUE triage from ${s.base_sha.slice(0, 7)}: resume agent a-9, stopped at the usage limit$`, "m"));
});

test("an answer run isn't resumed: the question is asked again in a new run", () => {
  const { run } = started();
  run(["set", "route", "answer"]);
  const r = run(["reconcile"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /an answer run isn't resumed: ask again with \/factory <the question>/);
});

test("the downtime of a run cut off mid-stage isn't counted against its minutes once it's reconciled", () => {
  const dead = () => {
    const r = started();
    r.run(["dispatch", "triage"]);
    // its session died 10 hours ago, mid-triage
    const file = path.join(r.s.run_dir, "state.json"), st = JSON.parse(fs.readFileSync(file, "utf8"));
    const back = (at) => new Date(Date.parse(at) - 600 * 60_000).toISOString();
    fs.writeFileSync(file, JSON.stringify({ ...st, created_at: back(st.created_at), updated_at: back(st.updated_at), dispatches: st.dispatches.map((d) => ({ ...d, at: back(d.at) })) }));
    return r;
  };
  const unreconciled = dead().run(["dispatch", "triage"]);
  assert.equal(unreconciled.status, 4);
  assert.match(unreconciled.stdout, /^BUDGET minutes 600\/90: triage not dispatched$/m);
  const r = dead();
  assert.equal(r.run(["reconcile"]).status, 0);
  const again = r.run(["dispatch", "triage"]);
  assert.equal(again.status, 0, again.stdout);
  assert.match(r.run(["spend"]).stdout, /^minutes 0\/90$/m);
});
