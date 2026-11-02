#!/usr/bin/env node
// ci-watch.mjs [--run <id>] [--sha <sha>] [--wait <seconds>] [--no-rerun] -> <run>/ci.json
// Waits for every workflow run on the PR head SHA, then classifies (Archon red_cause):
//   green     all runs succeeded
//   ours      a run failed and the same workflow is green on the base branch's head -> implementer fix round
//   inherited a run failed and the same workflow is also red on the base branch -> needs-human (the base is broken, not us)
//   flake     a run failed, `gh run rerun --failed` was tried once and the re-run succeeded -> green, noted
//   infra     the run was cancelled / timed out / never started before --wait -> needs-human, not a fix round
// REST only. Prints one line: CI <cause> sha=<7> runs=<n> [failed=<workflow:job:step>...]
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const ROOT = (() => { let d = process.cwd(); while (!fs.existsSync(path.join(d, ".factory")) && path.dirname(d) !== d) d = path.dirname(d); return d; })();
const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const runId = arg("--run") || fs.readFileSync(path.join(ROOT, ".factory/runs/ACTIVE"), "utf8").trim();
const RUN = path.join(ROOT, ".factory/runs", runId);
const state = JSON.parse(fs.readFileSync(path.join(RUN, "state.json"), "utf8"));
const git = (...a) => { try { return execFileSync("git", a, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } };
const sha = arg("--sha") || git("rev-parse", "HEAD");
const waitS = Number(arg("--wait", 900));
const rerun = !process.argv.includes("--no-rerun");
const repo = (git("remote", "get-url", "origin").match(/github\.com[:/]([^/]+\/[^/.]+)/) || [])[1];
const gh = (p, extra = []) => { const r = spawnSync("gh", ["api", p, ...extra], { encoding: "utf8" }); return r.status === 0 ? JSON.parse(r.stdout || "null") : null; };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const log = (l) => fs.appendFileSync(path.join(RUN, "run.log"), `- ${new Date().toISOString()} ci-watch: ${l}\n`);

const runsFor = (s) => (gh(`repos/${repo}/actions/runs?head_sha=${s}&per_page=50`)?.workflow_runs || []).filter(r => !["pull_request_target"].includes(r.event));
const settled = (r) => r.status === "completed";
const deadline = Date.now() + waitS * 1000;
let runs = runsFor(sha);
while ((runs.length === 0 || runs.some(r => !settled(r))) && Date.now() < deadline) { sleep(Math.min(20000, Math.max(2000, deadline - Date.now()))); runs = runsFor(sha); }

const failedSteps = (r) => (gh(`repos/${repo}/actions/runs/${r.id}/jobs`)?.jobs || [])
  .flatMap(j => (j.steps || []).filter(s => s.conclusion === "failure").map(s => `${r.name}:${j.name}:${s.name}`));
const summarize = (rs) => rs.map(r => ({ id: r.id, name: r.name, event: r.event, status: r.status, conclusion: r.conclusion, attempt: r.run_attempt, url: r.html_url }));

let cause, detail = [];
const bad = runs.filter(r => r.conclusion !== "success");
if (runs.length === 0) { cause = "infra"; detail = ["no workflow run appeared for the head SHA"]; }
else if (runs.some(r => !settled(r))) { cause = "infra"; detail = runs.filter(r => !settled(r)).map(r => `${r.name} still ${r.status} after ${waitS}s`); }
else if (bad.length === 0) cause = "green";
else if (bad.every(r => ["cancelled", "timed_out", "startup_failure", "action_required"].includes(r.conclusion))) { cause = "infra"; detail = bad.map(r => `${r.name}=${r.conclusion}`); }
else {
  detail = bad.flatMap(failedSteps);
  // Base-branch check: is the same workflow red on the base's head too? Then the red is inherited, not ours.
  const baseSha = git("rev-parse", `origin/${state.base_branch || "develop"}`) || git("rev-parse", state.base_branch || "develop");
  const baseRuns = runsFor(baseSha);
  // Inherited = the base's head fails the same workflow at the same step(s). A base that is red for a different reason
  // (e.g. a scaffold step) is noted but does not excuse our failure.
  const stepName = (s) => s.split(":").slice(1).join(":");
  const baseRed = baseRuns.filter(b => b.status === "completed" && b.conclusion === "failure");
  const baseFailed = new Set(baseRed.flatMap(failedSteps).map(stepName));
  const ourFailed = bad.flatMap(failedSteps).map(stepName);
  const inherited = bad.every(r => baseRed.some(b => b.name === r.name)) && ourFailed.length > 0 && ourFailed.every(st => baseFailed.has(st));
  if (inherited) { cause = "inherited"; detail.push(`same step(s) red on ${state.base_branch} @${baseSha.slice(0, 7)}: ${ourFailed.join(", ")}`); }
  else if (rerun) {
    // One re-run of the failed jobs only. Same SHA, same code: a pass on attempt 2 is a flake by definition.
    log(`re-running failed jobs once for ${bad.map(r => r.id).join(",")}`);
    for (const r of bad) spawnSync("gh", ["run", "rerun", String(r.id), "--failed"], { encoding: "utf8" });
    const d2 = Date.now() + Math.min(waitS, 600) * 1000;
    let again = runsFor(sha).filter(r => bad.some(b => b.id === r.id));
    while (again.some(r => !settled(r) || r.run_attempt < 2) && Date.now() < d2) { sleep(15000); again = runsFor(sha).filter(r => bad.some(b => b.id === r.id)); }
    const stillBad = again.filter(r => r.conclusion !== "success");
    cause = stillBad.length ? "ours" : "flake";
    if (cause === "flake") detail = again.map(r => `${r.name} passed on attempt ${r.run_attempt} (attempt 1 failed)`);
    else detail = stillBad.flatMap(failedSteps);
    runs = runsFor(sha);
  } else cause = "ours";
  // A base that is red for another reason is only a note: the failure is still classified (fix 17: `ours` with the note).
  if (!inherited && baseRed.length) detail.push(`note: ${state.base_branch} @${baseSha.slice(0, 7)} is red for a different reason (${[...baseFailed].join(", ") || "no step detail"})`);
}
// For a failure that is ours, save the failing job's log tail so the fix round reads one file, not the Actions UI.
if (cause === "ours") {
  const excerpt = [];
  for (const r of runs.filter(r => r.conclusion !== "success")) for (const j of (gh(`repos/${repo}/actions/runs/${r.id}/jobs`)?.jobs || []).filter(j => j.conclusion === "failure")) {
    const raw = spawnSync("gh", ["api", `repos/${repo}/actions/jobs/${j.id}/logs`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stdout || "";
    const lines = raw.split("\n").map(l => l.replace(/^\S+Z\s/, "").replace(/\x1b\[[0-9;]*m/g, ""));  // strip timestamps + ANSI
    const firstErr = lines.findIndex(l => /##\[error\]|FAIL |✗|✘|AssertionError|Error:/.test(l));
    const start = Math.max(0, (firstErr === -1 ? lines.length : firstErr) - 60);
    excerpt.push(`### ${r.name} / ${j.name} (${j.html_url})`, ...lines.slice(start, start + 200), "");
  }
  fs.writeFileSync(path.join(RUN, "ci-failure.log"), excerpt.join("\n"));
}
const out = { run: runId, sha, cause, detail, runs: summarize(runs), checked_at: new Date().toISOString() };
fs.writeFileSync(path.join(RUN, "ci.json"), JSON.stringify(out, null, 2) + "\n");
log(`${cause} sha=${sha.slice(0, 7)} ${detail.join("; ")}`);
console.log(`CI ${cause} sha=${sha.slice(0, 7)} runs=${runs.length}${detail.length ? " " + detail.join(" | ") : ""}`);
process.exit(cause === "green" || cause === "flake" ? 0 : cause === "ours" ? 1 : 3);
