#!/usr/bin/env node
// run-state.mjs — the ONLY writer of .factory/runs/<id>/state.json and .factory/runs/ACTIVE.
// Usage:
//   run-state.mjs init <slug> "<prompt>"          -> creates run, refuses if ACTIVE run not terminal
//   run-state.mjs get [run]                        -> prints state.json
//   run-state.mjs set <key> <value> [run]          -> sets a top-level key (JSON value if parseable)
//   run-state.mjs dispatch <stage> [run]           -> records a dispatch (sha, time) before a subagent starts
//   run-state.mjs done <stage> [run]               -> marks a stage done
//   run-state.mjs spend <stage> <tokens> [run]     -> records token spend, enforces tokens_per_run / minutes_per_run
//   run-state.mjs round <implement|review> [run]   -> increments a loop counter, prints OK|ESCALATE
//   run-state.mjs archive-review <lens> [run]      -> review-<lens>.md -> review-<lens>.round<N>.md before a re-review
//   run-state.mjs override <minutes|tokens|post_pr|dispatches|implement|review|ci> "<reason>" [run]
//                                                   -> a HUMAN lifts one cap for the rest of the run (recorded in state + run.log);
//                                                      the orchestrator never calls this on its own
//   run-state.mjs abandon [run]                    -> clears ACTIVE (branch untouched)
import fs from "node:fs";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import os from "node:os";

const ROOT = findRoot(process.cwd());
const RUNS = path.join(ROOT, ".factory", "runs");
const CONFIG = readJson(path.join(ROOT, ".factory", "config.json"), {});
const CAPS = Object.assign(
  { implement_rounds: 3, review_rounds: 2, ci_rounds: 1, dispatches_per_run: 30, minutes_per_run: 90,
    // Budget scales with the work: a fixed per-run overhead (triage, research, spec, tickets, review, PR) plus a per-ticket share.
    // tokens_per_run remains as the fallback before the ticket count is known.
    tokens_overhead: 700_000, tokens_per_ticket: 700_000, tokens_per_run: 1_500_000, minutes_per_ticket: 45,
    // Work after the PR exists (review-comment fixes, CI fix rounds, polish) is paced by the human, not by the ticket count,
    // so it has its own allowance instead of eating the build budget: once pr.json exists, spend counts here.
    tokens_post_pr: 400_000 },
  CONFIG.caps || {}
);
const tokenCap = (s) => s.tickets ? CAPS.tokens_overhead + CAPS.tokens_per_ticket * Math.max(1, s.tickets) : CAPS.tokens_per_run;
const minutesCap = (s) => s.tickets ? CAPS.minutes_per_run + CAPS.minutes_per_ticket * Math.max(0, s.tickets - 1) : CAPS.minutes_per_run;
const TERMINAL = new Set(["delivered", "needs-human", "failed", "abandoned", "no-action"]);

function findRoot(d) {
  while (!fs.existsSync(path.join(d, ".factory")) && path.dirname(d) !== d) d = path.dirname(d);
  return d;
}
function readJson(p, dflt) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return dflt; } }
function writeJson(p, o) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2) + "\n"); }
function sh(cmd) { try { return execSync(cmd, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return ""; } }
function activeRun() { try { return fs.readFileSync(path.join(RUNS, "ACTIVE"), "utf8").trim(); } catch { return ""; } }
function statePath(run) { return path.join(RUNS, run, "state.json"); }
function load(run) {
  run = run || activeRun();
  if (!run) die("no active run; pass a run id");
  const s = readJson(statePath(run), null);
  if (!s) die(`no state.json for run ${run}`);
  return [run, s];
}
function save(run, s) { s.updated_at = new Date().toISOString(); writeJson(statePath(run), s); }
function die(msg, code = 2) { console.error(`run-state: ${msg}`); process.exit(code); }
function log(line, run) {
  // During a run, log into the (untracked) run directory; `snapshot` merges it into .factory/log.md on the base branch.
  const id = run || activeRun();
  const dst = id ? path.join(RUNS, id, "run.log") : path.join(ROOT, ".factory", "log.md");
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.appendFileSync(dst, `- ${new Date().toISOString()} ${line}\n`);
}

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "init": {
    const [slug, prompt] = args;
    if (!slug) die("init <slug> \"<prompt>\"");
    const active = activeRun();
    if (active) {
      const s = readJson(statePath(active), {});
      if (!TERMINAL.has(s.stage)) die(`run ${active} is active at stage '${s.stage}'; resume or abandon it first`, 3);
    }
    const id = `${new Date().toISOString().slice(0, 10)}-${slug}`;
    const s = {
      id, slug, prompt: prompt || "", stage: "start", created_at: new Date().toISOString(),
      base_branch: null, target_branch: null, branch: null, base_sha: null,
      size: null, type: null, route: null,
      rounds: { implement: 0, review: 0, ci: 0 }, dispatches: [], spend: { tokens: 0, by_stage: {} },
      stages_done: [], attention: null,
    };
    save(id, s);
    fs.writeFileSync(path.join(RUNS, "ACTIVE"), id + "\n");
    log(`run: ${id} started prompt="${(prompt || "").slice(0, 80)}"`, id);
    console.log(id);
    break;
  }
  case "get": { const [, s] = load(args[0]); console.log(JSON.stringify(s, null, 2)); break; }
  case "set": {
    const [key, value, run] = args;
    const [id, s] = load(run);
    let v = value; try { v = JSON.parse(value); } catch {}
    s[key] = v; save(id, s); console.log(`ok ${key}`); break;
  }
  case "override": {
    const [what, reason, run] = args; const [id, s] = load(run);
    if (!["minutes", "tokens", "post_pr", "dispatches", "implement", "review", "ci"].includes(what) || !reason) { console.log("usage: override <minutes|tokens|post_pr|dispatches|implement|review|ci> \"<reason>\""); process.exit(2); }
    s.overrides = { ...(s.overrides || {}), [what]: { by: "human", reason, at: new Date().toISOString() } };
    save(id, s); log(`override ${what}: ${reason}`, id); console.log(`override ${what} recorded`); break;
  }
  case "dispatch": {
    const [stage, run] = args;
    const [id, s] = load(run);
    const ov = s.overrides || {};
    if (!ov.dispatches && s.dispatches.length >= CAPS.dispatches_per_run) { console.log("BUDGET dispatches"); process.exit(4); }
    const started = s.created_at ? (Date.now() - Date.parse(s.created_at)) / 60000 : 0;
    if (!ov.minutes && started > minutesCap(s)) { console.log(`BUDGET minutes ${Math.round(started)}/${minutesCap(s)}`); process.exit(4); }
    s.dispatches.push({ stage, sha: sh("git rev-parse HEAD"), at: new Date().toISOString() });
    s.stage = stage; save(id, s); console.log(`dispatched ${stage} #${s.dispatches.length}`); break;
  }
  case "done": {
    const [stage, run] = args; const [id, s] = load(run);
    if (!s.stages_done.includes(stage)) s.stages_done.push(stage);
    save(id, s); console.log(`done ${stage}`); break;
  }
  case "spend": {
    const [stage, tokens, run] = args; const [id, s] = load(run);
    const t = Number(tokens) || 0;
    const postPr = fs.existsSync(path.join(RUNS, id, "pr.json"));
    s.spend.by_stage[stage] = (s.spend.by_stage[stage] || 0) + t;
    if (postPr) s.spend.post_pr = (s.spend.post_pr || 0) + t; else s.spend.tokens += t;
    save(id, s);
    const cap = postPr ? CAPS.tokens_post_pr : tokenCap(s);
    const used = postPr ? s.spend.post_pr : s.spend.tokens;
    const label = postPr ? "post-pr tokens" : "tokens";
    // The post-PR allowance is its own cap: lifting the build budget does not lift it (fix 13 must still stop at 400k).
    if (used >= cap && !(s.overrides || {})[postPr ? "post_pr" : "tokens"]) { console.log(`BUDGET ${label} ${used}/${cap}`); process.exit(4); }
    if (used >= cap) { console.log(`ok ${label} ${used}/${cap} (cap overridden by human)`); break; }
    if (used >= cap * 0.7) console.log(`WARN 70% of ${label} budget (${used}/${cap})`);
    else console.log(`ok ${label} ${used}/${cap}`);
    break;
  }
  case "round": {
    const [loop, run] = args; const [id, s] = load(run);
    if (!["implement", "review", "ci"].includes(loop)) die("round <implement|review|ci>");
    const cap = loop === "implement" ? CAPS.implement_rounds : loop === "review" ? CAPS.review_rounds : CAPS.ci_rounds;
    s.rounds[loop] ||= 0;  // states written before ci_rounds existed have no counter
    if (s.rounds[loop] >= cap && !(s.overrides || {})[loop]) { console.log(`ESCALATE ${loop} rounds=${s.rounds[loop]} cap=${cap}`); process.exit(5); }
    s.rounds[loop] += 1; save(id, s);
    console.log(`OK ${loop} round ${s.rounds[loop]}/${cap}`); break;
  }
  case "archive-review": {
    // Before a re-review writes review-<lens>.md again, move the current one to review-<lens>.round<N>.md (N = next number);
    // synthesize.mjs reads every round in N order with the unsuffixed file last.
    const [lens, run] = args; const [id] = load(run);
    const dir = path.join(RUNS, id); const cur = path.join(dir, `review-${lens}.md`);
    if (!fs.existsSync(cur)) { console.log(`no review-${lens}.md to archive`); break; }
    const n = fs.readdirSync(dir).map(f => Number((f.match(new RegExp(`^review-${lens}\\.round(\\d+)\\.md$`)) || [])[1] || 0)).reduce((a, b) => Math.max(a, b), 0) + 1;
    fs.renameSync(cur, path.join(dir, `review-${lens}.round${n}.md`)); console.log(`archived review-${lens}.md -> review-${lens}.round${n}.md`); break;
  }
  case "abandon": {
    const [id, s] = load(args[0]); s.stage = "abandoned"; save(id, s);
    try { fs.unlinkSync(path.join(RUNS, "ACTIVE")); } catch {}
    log(`run: ${id} abandoned`, id); console.log(`abandoned ${id} (branch left in place)`); break;
  }
  case "snapshot": {
    // Copy the run dir to .factory/history/<id> and append run.log to .factory/log.md ON THE BASE BRANCH, in a temp worktree,
    // so the feature branch's HEAD (and the evidence pinned to it) never moves. .factory/runs/ itself is never tracked on
    // any branch (a checkout of a branch that tracked it would overwrite the live run). Used after merge and on needs-human closure.
    const [id, s] = load(args[0]);
    const base = s.base_branch || "main";
    if (!/^(?!-)[\w./-]+$/.test(base)) die(`base branch '${base}' is not a branch name`);
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "factory-snap-"));
    const git = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
    if (process.env.FACTORY_COMMIT_TRAILER === undefined) die("export FACTORY_COMMIT_TRAILER (the session's commit attribution lines; empty if none)");
    git(ROOT, "worktree", "add", "-q", wt, base);
    try {
    const dst = path.join(wt, ".factory", "history", id);
    fs.mkdirSync(dst, { recursive: true });
    fs.cpSync(path.join(RUNS, id), dst, { recursive: true, filter: (p) => !/\/(captures|app-logs|qa)\//.test(p + "/") && !/\.png$/.test(p) });
    // Append only the run.log lines that are not already in log.md (a run is snapshotted more than once: at needs-human, after
    // merge, after post-merge), so the base's log never carries the same line twice.
    const runLog = path.join(RUNS, id, "run.log");
    const logMd = path.join(wt, ".factory", "log.md");
    if (fs.existsSync(runLog)) {
      const have = new Set((fs.existsSync(logMd) ? fs.readFileSync(logMd, "utf8") : "").split("\n"));
      const fresh = fs.readFileSync(runLog, "utf8").split("\n").filter(l => l.trim() && !have.has(l));
      if (fresh.length) fs.appendFileSync(logMd, (fs.existsSync(logMd) && !fs.readFileSync(logMd, "utf8").endsWith("\n") ? "\n" : "") + fresh.join("\n") + "\n");
    }
    git(wt, "add", "--", `.factory/history/${id}`, ".factory/log.md");
    // A repeat snapshot with nothing new is a no-op, not a crash that leaks the worktree.
    const changed = (() => { try { git(wt, "diff", "--cached", "--quiet"); return false; } catch { return true; } })();
    if (changed) execFileSync("git", ["commit", "-q", "-F", "-"], { cwd: wt, input: `factory(run): ${id} snapshot (${s.stage})\n\n${process.env.FACTORY_COMMIT_TRAILER}\n` });
    console.log(changed ? `snapshot ${git(wt, "rev-parse", "--short", "HEAD")} on ${base}` : `snapshot unchanged on ${base}`);
    } finally { git(ROOT, "worktree", "remove", "--force", wt); }
    break;
  }
  default: die("unknown command");
}
