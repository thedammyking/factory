#!/usr/bin/env node
// run-state.mjs — the ONLY writer of .factory/runs/<id>/state.json and .factory/runs/ACTIVE.
// Usage:
//   run-state.mjs init <slug> "<prompt>" [--session <id>]  -> creates run, refuses if ACTIVE run not terminal (and says if it is stale)
//   run-state.mjs get [run]                        -> prints state.json
//   run-state.mjs set <key> <value> [run]          -> sets a top-level key (JSON value if parseable); `branch` also updates ACTIVE.
//                                                      Right after init: set attribution '{"commit":"…","pr":"…"}' (the session's lines)
//   run-state.mjs dispatch <stage> [run]           -> records a dispatch (sha, time) before a subagent starts; WARN once at 70% of minutes
//   run-state.mjs agent <agent-id> [run]           -> attaches the agent id to the last dispatch (reconcile resumes it)
//   run-state.mjs done <stage> [run]               -> marks a stage done
//   run-state.mjs spend <stage> <tokens> [run]     -> records token spend, enforces the token caps; WARN once at 70%
//   run-state.mjs round <implement|review|ci> [run] -> increments a loop counter, prints OK|ESCALATE
//   run-state.mjs archive-review <lens> [run]      -> review-<lens>.md -> review-<lens>.round<N>.md before a re-review
//   run-state.mjs ticket <NN-slug> <status> [run]  -> rewrites the ticket's **Status:** line (tickets/NN-slug.md in the run dir)
//   run-state.mjs next-ticket [run]                -> NEXT <id>[,<id>...] (in-progress first, then unblocked ready) | DONE | BLOCKED <id>:<waits on>
//   run-state.mjs reconcile [run]                  -> the resume protocol: apps down, salvage, stage to continue, verify --fast, frontier
//   run-state.mjs override <minutes|tokens|post_pr|dispatches|implement|review|ci> "<reason>" [run]
//                                                   -> a HUMAN lifts one cap for the rest of the run (recorded in state + run.log);
//                                                      the orchestrator never calls this on its own
//   run-state.mjs approve migrations "<reason>" [run] -> a HUMAN approves the run's migrations (a merge fact for maintenance runs)
//   run-state.mjs abandon [run]                    -> clears ACTIVE (branch untouched)
//   run-state.mjs snapshot [run]                   -> commits the run dir to .factory/history/<id> on the base branch
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { projectRoot, mainRoot, activeRun, readJson, arg, trailer, commitToBase } from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = projectRoot();
const RUNS = path.join(mainRoot(ROOT), ".factory", "runs");
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
const TICKET_STATUS = ["ready-for-agent", "in-progress", "in-review", "built", "done", "blocked", "dropped"];
// What each stage leaves behind; reconcile reports whether it exists. `plan:NN` and `implement:NN` name a ticket.
const OUTPUT = { triage: "triage.md", research: "research.md", grill: "grill.md", spec: "spec.md", "builder-check": "builder-check.md",
  tickets: "tickets", plan: "tickets/{n}/plan.md", implement: "implementation.md", verify: "evidence.json", qa: "qa.json",
  "review-code": "review-code.md", "review-ui": "review-ui.md", "review-security": "review-security.md", synthesize: "findings.json",
  pr: "pr.json", ci: "ci.json", decision: "decision.json", retro: "retro.md" };

const git = (...a) => { try { return execFileSync("git", a, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } };
const writeJson = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2) + "\n"); };
const statePath = (run) => path.join(RUNS, run, "state.json");
const activeId = () => activeRun(ROOT)?.id || "";
function load(run) {
  run = run || activeId();
  if (!run) die("no active run; pass a run id");
  const s = readJson(statePath(run), null);
  if (!s) die(`no state.json for run ${run}`);
  return [run, s];
}
function save(run, s) { s.updated_at = new Date().toISOString(); writeJson(statePath(run), s); }
function die(msg, code = 2) { console.error(`run-state: ${msg}`); process.exit(code); }
function log(line, run) {
  // During a run, log into the (untracked) run directory; `snapshot` merges it into .factory/log.md on the base branch.
  const id = run || activeId();
  const dst = id ? path.join(RUNS, id, "run.log") : path.join(ROOT, ".factory", "log.md");
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.appendFileSync(dst, `- ${new Date().toISOString()} ${line}\n`);
}
function tickets(id) {
  const dir = path.join(RUNS, id, "tickets");
  return (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter(f => /^\d{2}-.+\.md$/.test(f)).sort().map(f => {
    const md = fs.readFileSync(path.join(dir, f), "utf8");
    const blocked = (md.match(/^\*\*Blocked by:\*\*\s*(.*)$/m) || [])[1] || "";
    return { id: f.slice(0, -3), n: f.slice(0, 2), file: path.join(dir, f),
      status: (md.match(/^\*\*Status:\*\*\s*([\w-]+)/m) || [])[1] || "ready-for-agent", blockedBy: blocked.match(/\b\d{2}\b/g) || [] };
  });
}
function nextTicket(id) {
  const all = tickets(id);
  if (!all.length) return "NONE (no tickets)";
  const finished = new Set(all.filter(t => ["built", "done"].includes(t.status)).map(t => t.n));
  const open = all.filter(t => !["built", "done", "dropped"].includes(t.status));
  if (!open.length) return "DONE";
  const takeable = [...open.filter(t => t.status === "in-progress"),
    ...open.filter(t => t.status === "ready-for-agent" && t.blockedBy.every(b => finished.has(b)))];
  return takeable.length ? `NEXT ${takeable.map(t => t.id).join(",")}`
    : `BLOCKED ${open.map(t => `${t.id}:${t.status === "ready-for-agent" ? t.blockedBy.filter(b => !finished.has(b)).join("+") : t.status}`).join(" ")}`;
}

const [cmd, ...rest] = process.argv.slice(2);
const args = rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1].startsWith("--")));

switch (cmd) {
  case "init": {
    const [slug, prompt] = args;
    if (!slug) die("init <slug> \"<prompt>\" [--session <id>]");
    const active = activeRun(ROOT);
    if (active) {
      const s = readJson(statePath(active.id), {});
      if (!TERMINAL.has(s.stage)) {
        // Stale = nothing moved (state or branch) for longer than the run's minutes budget. Reported, never overwritten.
        const moved = Math.max(Date.parse(s.updated_at || s.created_at || 0) || 0, Number(s.branch && git("log", "-1", "--format=%ct", s.branch)) * 1000 || 0);
        const idle = Math.round((Date.now() - moved) / 60000);
        die(`run ${active.id} is active at stage '${s.stage}'` + (idle > minutesCap(s)
          ? `; it looks stale (nothing moved for ${idle} min, over its ${minutesCap(s)}-min budget): \`/factory abandon ${active.id}\` clears it and keeps the branch`
          : "; resume or abandon it first"), 3);
      }
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
    writeJson(path.join(RUNS, "ACTIVE"), { id, branch: null, session: arg("--session") || process.env.CLAUDE_CODE_SESSION_ID || null, started_at: s.created_at });
    log(`run: ${id} started prompt="${(prompt || "").slice(0, 80)}"`, id);
    console.log(id);
    break;
  }
  case "get": { const [, s] = load(args[0]); console.log(JSON.stringify(s, null, 2)); break; }
  case "set": {
    const [key, value, run] = args;
    const [id, s] = load(run);
    let v = value; try { v = JSON.parse(value); } catch {}
    s[key] = v; save(id, s);
    const active = activeRun(ROOT);
    if (key === "branch" && active?.id === id) writeJson(path.join(RUNS, "ACTIVE"), { ...active, branch: v });
    console.log(`ok ${key}`); break;
  }
  case "override": {
    const [what, reason, run] = args; const [id, s] = load(run);
    if (!["minutes", "tokens", "post_pr", "dispatches", "implement", "review", "ci"].includes(what) || !reason) { console.log("usage: override <minutes|tokens|post_pr|dispatches|implement|review|ci> \"<reason>\""); process.exit(2); }
    s.overrides = { ...(s.overrides || {}), [what]: { by: "human", reason, at: new Date().toISOString() } };
    save(id, s); log(`override ${what}: ${reason}`, id); console.log(`override ${what} recorded`); break;
  }
  case "approve": {
    // An approval is not an override: it satisfies a merge fact instead of lifting a cap, so it does not block auto-merge.
    const [what, reason, run] = args; const [id, s] = load(run);
    if (what !== "migrations" || !reason) { console.log("usage: approve migrations \"<reason>\""); process.exit(2); }
    s.approvals = { ...(s.approvals || {}), [what]: { by: "human", reason, at: new Date().toISOString() } };
    save(id, s); log(`approve ${what}: ${reason}`, id); console.log(`approval ${what} recorded`); break;
  }
  case "dispatch": {
    const [stage, run] = args;
    const [id, s] = load(run);
    const ov = s.overrides || {};
    if (!ov.dispatches && s.dispatches.length >= CAPS.dispatches_per_run) { console.log("BUDGET dispatches"); process.exit(4); }
    const started = s.created_at ? (Date.now() - Date.parse(s.created_at)) / 60000 : 0;
    if (!ov.minutes && started > minutesCap(s)) { console.log(`BUDGET minutes ${Math.round(started)}/${minutesCap(s)}`); process.exit(4); }
    if (!ov.minutes && started >= minutesCap(s) * 0.7 && !s.warned?.minutes) {
      s.warned = { ...s.warned, minutes: true }; console.log(`WARN 70% of minutes budget (${Math.round(started)}/${minutesCap(s)})`);
    }
    s.dispatches.push({ stage, sha: git("rev-parse", "HEAD"), at: new Date().toISOString() });
    s.stage = stage; save(id, s); console.log(`dispatched ${stage} #${s.dispatches.length}`); break;
  }
  case "agent": {
    const [agentId, run] = args; const [id, s] = load(run);
    if (!agentId || !s.dispatches.length) die("agent <agent-id> needs a dispatch to attach to");
    s.dispatches.at(-1).agent = agentId; save(id, s); console.log(`agent ${agentId} -> ${s.dispatches.at(-1).stage}`); break;
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
    const cap = postPr ? CAPS.tokens_post_pr : tokenCap(s);
    const used = postPr ? s.spend.post_pr : s.spend.tokens;
    const key = postPr ? "post_pr" : "tokens", label = postPr ? "post-pr tokens" : "tokens";
    // The post-PR allowance is its own cap: lifting the build budget does not lift it (fix 13 must still stop at 400k).
    const lifted = !!(s.overrides || {})[key];
    const warn = !lifted && used >= cap * 0.7 && used < cap && !s.warned?.[key];
    if (warn) s.warned = { ...s.warned, [key]: true };
    save(id, s);
    if (used >= cap && !lifted) { console.log(`BUDGET ${label} ${used}/${cap}`); process.exit(4); }
    console.log(used >= cap ? `ok ${label} ${used}/${cap} (cap overridden by human)` : warn ? `WARN 70% of ${label} budget (${used}/${cap})` : `ok ${label} ${used}/${cap}`);
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
  case "ticket": {
    const [tid, status, run] = args; const [id] = load(run);
    const t = tickets(id).find(t => t.id === tid || t.n === tid);
    if (!t || !TICKET_STATUS.includes(status)) die(`ticket <NN-slug> <${TICKET_STATUS.join("|")}>${t ? "" : `: no ticket ${tid}`}`);
    const md = fs.readFileSync(t.file, "utf8");
    fs.writeFileSync(t.file, /^\*\*Status:\*\*.*$/m.test(md) ? md.replace(/^\*\*Status:\*\*.*$/m, `**Status:** ${status}`) : `**Status:** ${status}\n${md}`);
    log(`ticket ${t.id}: ${t.status} -> ${status}`, id); console.log(`ticket ${t.id} ${status}`); break;
  }
  case "next-ticket": { const [id] = load(args[0]); const r = nextTicket(id); console.log(r); process.exit(r.startsWith("BLOCKED") ? 5 : 0); }
  case "reconcile": {
    // The resume protocol (design: "Budgets, failure and recovery"). Reads the disk, never an agent's memory.
    const [id, s] = load(args[0]);
    const RUN = path.join(RUNS, id);
    const last = s.dispatches.at(-1) || null;
    // 1. stale dev servers and simulators down (idempotent)
    spawnSync(process.execPath, [path.join(HERE, "run-apps.mjs"), "down", "--run", id], { cwd: ROOT, stdio: "ignore", timeout: 60_000 });
    // 2. salvage what a dead implementer left uncommitted, so it is visible rather than lost or silently kept. Never .factory/:
    //    a recipe edited mid-run is reported, not committed (committing it would make the weakened recipe "trusted").
    let salvaged = "none";
    const recipeDirty = git("status", "--porcelain", "--", ".factory/setup.json");
    if (git("status", "--porcelain", "--", ".", ":(exclude).factory")) {
      try {
        const msg = `wip(factory): salvaged from round ${s.rounds.implement} (${last?.stage || "unknown stage"})\n\n${trailer("commit", s)}\n`;
        execFileSync("git", ["add", "-A", "--", ".", ":(exclude).factory"], { cwd: ROOT, stdio: "ignore" });
        execFileSync("git", ["commit", "-q", "-F", "-"], { cwd: ROOT, input: msg, stdio: ["pipe", "ignore", "pipe"] });
        salvaged = git("rev-parse", "--short", "HEAD");
      } catch (e) { salvaged = `refused (${String(e.message).split("\n")[0].slice(0, 120)})`; }
    }
    // 3. the stage to continue: done -> next, a review -> fresh (a half-formed verdict must not anchor the retry), a known agent -> resume
    const [stage, n] = (last?.stage || "").split(":");
    const out = OUTPUT[stage] ? (fs.existsSync(path.join(RUN, OUTPUT[stage].replace("{n}", n || ""))) ? "present" : "missing") : "unknown";
    const commits = last?.sha ? Number(git("rev-list", "--count", `${last.sha}..HEAD`) || 0) : 0;
    const action = !last ? "start" : s.stages_done.includes(last.stage) ? "next" : stage.startsWith("review") ? "fresh" : last.agent ? `resume ${last.agent}` : "fresh";
    // An attempt counts as a round only if it produced commits: an API error that produced nothing costs nothing.
    if (stage === "implement" && action !== "next" && commits === 0 && s.rounds.implement > 0 && !last.refunded) { s.rounds.implement -= 1; last.refunded = true; }
    save(id, s);
    // 4. known state, not the last agent's claim
    const v = spawnSync(process.execPath, [path.join(HERE, "verify.mjs"), "--fast", "--run", id], { cwd: ROOT, encoding: "utf8", timeout: 15 * 60_000 });
    const verify = (v.stdout || "").match(/^VERIFY .*$/m)?.[0] || `verify exit ${v.status}`;
    // 5. the frontier
    const line = `RECONCILE ${id} stage=${last?.stage || "none"} dispatched_at=${(last?.sha || "").slice(0, 7) || "-"} output=${out} commits=${commits} salvaged=${salvaged}`
      + `${recipeDirty ? " recipe=MODIFIED(needs-human)" : ""} action=${action} rounds.implement=${s.rounds.implement} next=${nextTicket(id).replace(/\s+/g, "_")}\n  ${verify}`;
    log(line.split("\n")[0], id); console.log(line); break;
  }
  case "abandon": {
    const [id, s] = load(args[0]); s.stage = "abandoned"; save(id, s);
    if (activeId() === id) fs.rmSync(path.join(RUNS, "ACTIVE"), { force: true });
    log(`run: ${id} abandoned`, id); console.log(`abandoned ${id} (branch left in place)`); break;
  }
  case "snapshot": {
    // Copy the run dir to .factory/history/<id> and append run.log to .factory/log.md ON THE BASE BRANCH, without checking it
    // out (commitToBase), so the feature branch's HEAD (and the evidence pinned to it) never moves and a checkout of the base
    // elsewhere is fast-forwarded rather than refused. .factory/runs/ itself is never tracked on any branch.
    // Used after merge and on needs-human closure.
    const [id, s] = load(args[0]);
    const base = s.base_branch || "main";
    let msg; try { msg = `factory(run): ${id} snapshot (${s.stage})\n\n${trailer("commit", s)}\n`; } catch (e) { die(e.message); }
    let sha;
    try {
      sha = commitToBase(ROOT, base, msg, (wt) => {
        const dst = path.join(wt, ".factory", "history", id);
        fs.mkdirSync(dst, { recursive: true });
        fs.cpSync(path.join(RUNS, id), dst, { recursive: true, filter: (p) => !/\/(captures|app-logs|qa|profile-data)\//.test(p + "/") && !/\.png$/.test(p) });
        // Append only the run.log lines that are not already in log.md (a run is snapshotted more than once: at needs-human, after
        // merge, after post-merge), so the base's log never carries the same line twice.
        const runLog = path.join(RUNS, id, "run.log"), logMd = path.join(wt, ".factory", "log.md");
        if (fs.existsSync(runLog)) {
          const cur = fs.existsSync(logMd) ? fs.readFileSync(logMd, "utf8") : "";
          const have = new Set(cur.split("\n"));
          const fresh = fs.readFileSync(runLog, "utf8").split("\n").filter(l => l.trim() && !have.has(l));
          if (fresh.length) fs.appendFileSync(logMd, (cur && !cur.endsWith("\n") ? "\n" : "") + fresh.join("\n") + "\n");
        }
        return [`.factory/history/${id}`, ...(fs.existsSync(logMd) ? [".factory/log.md"] : [])];
      });
    } catch (e) { die(`snapshot failed: ${e.message}`); }
    console.log(sha ? `snapshot ${sha} on ${base}` : `snapshot unchanged on ${base}`);
    break;
  }
  default: die("unknown command");
}
