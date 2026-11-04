#!/usr/bin/env node
// ci-watch.mjs [--wait <seconds>] [--every <seconds>] — reads GitHub Actions on the run's PR at the run head and writes
// ci.json, which merge-decision reads. Takes --run <id>, or derives the run from the run worktree it runs in. REST only
// (`gh api`). It polls the head's workflow runs every --every seconds (20) until they have all completed, for --wait
// seconds (900) at most, then classifies them:
//   green      every workflow run passed
//   flake      a workflow run failed, and the one re-run of its failed jobs passed: same code, so the red was CI's. A
//              workflow run is re-run only on its first attempt, so no head is re-run twice
//   ours       a workflow run failed, again when re-run, at a step that isn't red on the base's head. A base red at other
//              steps is noted in ci.json, and the red stays the run's (design fix 17)
//   inherited  every failing step is red on the base's head too (once its pending workflow runs complete), so nothing is
//              re-run: the base is broken, not the run
//   infra      no workflow at the head, no workflow run in time, one not done in time, cancelled, timed out or never
//              started, or GitHub refusing a call: CI reached no result
// A failing step is <workflow> / <job> / <step>. On ours or inherited each failing job's whole log is saved as
// logs/ci-failure.log in the run dir, timestamps and ANSI stripped, and its digest printed. The last line is the verdict,
// `CI <cause> at <sha>: <why>`, but on inherited or infra, which write attention-ci.md and end the run needs-human
// through run-state: then it's `needs-human: <attention item>`, and it exits 1. Exits 2 when it can't start.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readJson, arg, git, gitError, runContext, liveBase, pause, ghApi, digest, shellQuote as q, attentionItem } from "./lib.mjs";

const die = (msg) => { console.error(`ci-watch: ${msg}`); process.exit(2); };
const WAIT = Number(arg("--wait", 900)), EVERY = Number(arg("--every", 20));
if (!(WAIT >= 0 && EVERY >= 0)) die("--wait and --every take seconds");
const ctx = runContext(), s = readJson(ctx.state), dir = ctx.runDir, pr = readJson(path.join(dir, "pr.json"));
if (!pr) die("no pr.json: CI is read on the run's PR, which pr-open.mjs opens");
const head = git(ctx.worktree, "rev-parse", "HEAD"), short = (sha) => String(sha).slice(0, 7);
const workflows = git(ctx.worktree, "ls-tree", "--name-only", "HEAD", ".github/workflows/");

let refused = null;  // the first call that failed, which leaves CI unread
const api = (...a) => { const r = ghApi(...a); if (!r.ok) refused ??= `GitHub refused ${a.at(-1)}: ${r.message}`; return r; };
// ponytail: one page of 100 workflow runs and of 100 jobs each; follow GitHub's Link header if a head ever has more.
const runsAt = (sha) => api(`repos/${pr.repo}/actions/runs?head_sha=${sha}&per_page=100`).json?.workflow_runs ?? null;
const done = (r) => r.status === "completed", OK = ["success", "neutral", "skipped"];
// The failed jobs of each failed workflow run's latest attempt, and each one's failing steps (the job alone when no step
// failed).
const failedJobs = (runs) => runs.filter((r) => r.conclusion === "failure").flatMap((r) =>
  (api(`repos/${pr.repo}/actions/runs/${r.id}/attempts/${r.run_attempt}/jobs?per_page=100`).json?.jobs ?? []).filter((j) => j.conclusion === "failure").map((j) => ({ ...j, workflow: r.name })));
const steps = (j) => { const st = (j.steps || []).filter((x) => x.conclusion === "failure").map((x) => `${j.workflow} / ${j.name} / ${x.name}`); return st.length ? st : [`${j.workflow} / ${j.name}`]; };
// sha's workflow runs once ready(runs) holds, polled every EVERY seconds for WAIT seconds at most; null once GitHub refuses.
function watch(sha, ready) {
  for (const end = Date.now() + WAIT * 1000; ; pause(EVERY * 1000)) {
    const runs = runsAt(sha);
    if (!runs || ready(runs) || Date.now() >= end) return runs;
  }
}
// [cause, why] for the head's workflow runs as they stand; cause failure while one failed, which only the base and a
// re-run can tell apart.
function classify(runs) {
  if (!runs) return ["infra", refused];
  if (!runs.length) return ["infra", workflows ? `no workflow run appeared for ${short(head)} in ${WAIT} s` : "the head has no workflow in .github/workflows, so nothing runs CI on it"];
  const pending = runs.filter((r) => !done(r)), stuck = runs.filter((r) => !OK.includes(r.conclusion)), again = runs.filter((r) => r.run_attempt > 1);
  if (pending.length) return ["infra", pending.map((r) => `${r.name} still ${r.status} after ${WAIT} s`).join(", ")];
  if (runs.some((r) => r.conclusion === "failure")) return ["failure"];
  if (stuck.length) return ["infra", stuck.map((r) => `${r.name} ${r.conclusion}`).join(", ")];
  return again.length ? ["flake", again.map((r) => `${r.name} passed on attempt ${r.run_attempt}`).join(", ")]
    : ["green", `${runs.length} workflow run${runs.length > 1 ? "s" : ""} passed`];
}

const ci = { run: ctx.id, sha: head };
let runs = workflows ? watch(head, (rs) => rs.length && rs.every(done)) : [], [cause, why] = classify(runs);
if (cause === "failure") {
  // The base's head as origin has it now, its pending workflow runs waited for.
  // ponytail: a base whose workflows run only on pull_request has no workflow runs of its own, so a red there is never
  // seen and an inherited red reads as ours; read the base's last merged PR's runs if that bites.
  let tip = null; try { tip = git(ctx.worktree, "rev-parse", liveBase(ctx.worktree, s.base_branch)); } catch (e) { refused ??= `${s.base_branch} couldn't be fetched: ${gitError(e)}`; }
  const red = tip ? failedJobs(watch(tip, (rs) => rs.every(done)) ?? []).flatMap(steps) : [], same = (js) => js.length > 0 && js.flatMap(steps).every((st) => red.includes(st));
  ci.base = { branch: s.base_branch, sha: tip, failing: red };
  let failed = failedJobs(runs);
  if (!refused && !same(failed)) {
    const first = runs.filter((r) => r.conclusion === "failure" && r.run_attempt === 1);
    for (const r of first) api("-X", "POST", `repos/${pr.repo}/actions/runs/${r.id}/rerun-failed-jobs`);
    if (first.length && !refused) {
      ci.reran = first.map((r) => r.id);
      runs = watch(head, (rs) => first.every((r) => rs.some((x) => x.id === r.id && x.run_attempt > r.run_attempt && done(x))));
      [cause, why] = classify(runs);
      if (cause === "failure") failed = failedJobs(runs);
    }
  }
  if (cause === "failure") {
    ci.failing = failed.flatMap(steps);
    [cause, why] = [same(failed) ? "inherited" : "ours", ci.failing.join(", ")];
    // Each failing job's whole log, one file for the fix round to read, with GitHub's timestamps and colours taken out.
    // A log GitHub won't give leaves its refusal in its place, and the cause stands.
    const strip = (text) => text.replace(/^﻿/, "").replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/gm, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    const log = (j) => { const r = ghApi(`repos/${pr.repo}/actions/jobs/${j.id}/logs`); return r.ok ? strip(r.text) : `GitHub refused its log: ${r.message}\n`; };
    const text = failed.map((j) => `### ${j.workflow} / ${j.name} (${j.html_url})\n${log(j)}`).join("\n");
    fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
    fs.writeFileSync(ci.log = path.join(dir, "logs", "ci-failure.log"), text);
    console.log(digest(text, ci.log));
  }
  if (cause === "ours" && red.length) ci.note = `${s.base_branch} at ${short(tip)} is red too, at ${red.join(", ")}: not every step failing here, so the red is the run's`;
}
if (refused) [cause, why] = ["infra", refused];
Object.assign(ci, { cause, why, runs: (runs || []).map((r) => ({ id: r.id, name: r.name, event: r.event, conclusion: r.conclusion, attempt: r.run_attempt, url: r.html_url })),
  checked_at: new Date().toISOString() });
const CI_JSON = path.join(dir, "ci.json"), verdict = `CI ${cause} at ${short(head)}: ${why}`;
fs.writeFileSync(CI_JSON, JSON.stringify(ci, null, 2) + "\n");
if (!["inherited", "infra"].includes(cause)) { console.log(verdict); process.exit(0); }

// A red the run can't fix, or no result: the human's. A script is named as the developer's shell finds it, never by their
// home directory, since the item becomes the PR's comment.
const script = (name) => { const f = fileURLToPath(new URL(name, import.meta.url)), home = os.homedir(); return f.startsWith(home + path.sep) ? `~/${q(path.relative(home, f))}` : q(f); };
const file = path.join(dir, "attention-ci.md"), resume = `/factory resume ${ctx.id}`;
const stop = cause === "inherited" ? {
  headline: `CI on PR #${pr.number} fails where ${s.base_branch} already fails`,
  happened: `CI at \`${short(head)}\` fails at ${ci.failing.map((st) => `\`${st}\``).join(", ")}, and \`${s.base_branch}\` at \`${short(ci.base.sha)}\` fails at the same step${ci.failing.length > 1 ? "s" : ""}. `
    + "The red is the base's, so nothing was re-run or fixed.",
  recommendation: `Fix ${s.base_branch} first, then bring PR #${pr.number} up to it.`,
  options: [[`node ${script("sync-base.mjs")} before-merge --run ${ctx.id}`, `once ${s.base_branch} is fixed, merges it into PR #${pr.number} on GitHub and the run branch with it`],
    [resume, "then reads CI on the PR again, at the head that merge made"]],
} : {
  headline: `CI on PR #${pr.number} reached no result`,
  happened: `CI at \`${short(head)}\`: ${why}. Nothing was fixed.`,
  recommendation: workflows ? `Clear what stopped CI on PR #${pr.number}, re-running it there if it needs that.` : `Give the project a GitHub Actions workflow, or merge PR #${pr.number} on your own judgement.`,
  options: [[resume, "reads CI on the PR again, at the same head"]],
};
fs.writeFileSync(file, attentionItem({ id: ctx.id, stage: "ci", evidence: [CI_JSON, ...(ci.log ? [ci.log] : [])], ...stop,
  options: [...stop.options, [`/factory abandon ${ctx.id}`, "ends the run abandoned; its branch and PR are kept"]] }));
const r = spawnSync(process.execPath, [fileURLToPath(new URL("run-state.mjs", import.meta.url)), "set", "stage", "needs-human", "--run", ctx.id], { encoding: "utf8" });
if (r.status) die(`run-state set stage needs-human failed: ${r.stderr}`);
console.log(`${verdict}\nneeds-human: ${file}`);
process.exit(1);
