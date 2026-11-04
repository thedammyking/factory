#!/usr/bin/env node
// run-state.mjs — the only writer of a run's state.json.
// Every command but init and status takes --run <id>, or derives the run from the run worktree it runs in.
//   run-state.mjs init < request              -> the run worktree detached at the base tip, the run dir inside it with
//                                                state.json and prompt.md; records the owning session; prints the state.
//                                                With FACTORY_GRILL_ANSWERS set (an unattended run), copies that file in
//                                                as grill-answers.md
//   run-state.mjs lane                        -> a build or oneshot run, once: switches the run worktree to a new lane
//                                                branch at its base's tip (prefix and base from triage's type and the
//                                                branching model, then the request issue's key, then triage's slug) and
//                                                records branch, base_branch, target_branch and base_sha
//   run-state.mjs approve spec approved|revise -> the human's decision at the spec gate; approved covers spec.md as it is,
//                                                and until then a build run dispatches nothing past the builder check
//   run-state.mjs notion [pushed <url> | failed "<why>"] -> an approved spec's Notion copy, which the orchestrator pushes
//                                                through the Notion MCP: prints `skip: …` when the config names no Notion
//                                                parent page (docs repo), else the page as JSON (parent, the page to
//                                                overwrite or null, title, content opening with the copy notice); pushed
//                                                writes the page's URL into spec.md's frontmatter, keeping the approval;
//                                                failed logs the one line a failed push leaves
//   run-state.mjs approve tickets approved|revise -> the human's decision at the ticket gate; approved covers the cut and
//                                                the edges of tickets/NN-slug.md as they are, and until then a build run
//                                                dispatches nothing past the tickets
//   run-state.mjs ticket <NN> <status>        -> after the ticket gate, the only change to a ticket's Status line that
//                                                keeps the approval
//   run-state.mjs next-ticket                 -> after the ticket gate, `NEXT <NN-slug>` per takeable ticket (in-progress
//                                                first), else `DONE`, else `BLOCKED <NN-slug>: <why>` per open ticket,
//                                                from lib's frontier
//   run-state.mjs get                         -> prints state.json
//   run-state.mjs set <key> <value>           -> sets a top-level key (JSON when it parses); `route` must be a route and
//                                                `stage` an outcome (dispatch sets the working stages, abandon its own);
//                                                a run with an override ends needs-human when set delivered, and the time
//                                                a run waits needs-human, failed or suspended (a usage-limit stop) isn't
//                                                counted against its minutes; set failed when the last stage's agent
//                                                stopped at the usage limit, it ends the run suspended instead
//   run-state.mjs dispatch <stage> [--agent <id> | --log <path> --pid <pid> --session <id>] -> before the agent starts:
//                                                measures spend and checks the caps, printing `WARN 70% …` once per cap, or
//                                                `BUDGET <cap> <used>/<limit>` and the spend by stage and exiting 4 without
//                                                dispatching; then records the stage, the time and a HEAD: the ticket's
//                                                worktree's once it has one, else the run worktree's, which a ticket's
//                                                worktree is cut from. It moves an earlier output aside (<name>.round<N>.md),
//                                                since a dispatch with no output yet is working; a stage of one ticket is
//                                                <stage>:<NN>, as in plan:02. Once the agent has started, --agent attaches
//                                                its id to that dispatch, or --log, --pid and --session a child's
//                                                stream-json log, PID and session id
//   run-state.mjs round implement:<NN>        -> before a fix round of ticket NN: `OK implement:NN round <n>/<cap>`, or
//                                                `ESCALATE …` and exit 5 once caps.implement_rounds (3) are spent, or at
//                                                once when its evidence shows the same failure as the round before. An
//                                                attempt that made no commits on the ticket's branch costs no round, and a
//                                                round counted since the last attempt isn't counted again
//   run-state.mjs reconcile [--take-over]     -> what /factory resume runs, from disk alone. A run another session owns (the
//                                                one init recorded) prints `OWNED …` with that session's last activity and
//                                                exits 6 changing nothing, until --take-over makes this session its owner;
//                                                a child still running prints `WORKING …` and exits 6 too. Otherwise: the
//                                                downtime of a run cut off mid-stage is waiting, not run time; run-apps
//                                                down; what each dead implementer left uncommitted in its ticket's
//                                                worktree is committed as `wip(factory): salvaged from round N`; then
//                                                `done: …` (stages never run again), `CONTINUE <stage> …` per stage cut
//                                                off mid-flight (none on a run stopped needs-human), verify --fast where
//                                                they work (else on the run branch), and next-ticket's frontier
//   run-state.mjs done <stage>                -> marks a stage done
//   run-state.mjs spend                       -> measures spend (it takes no number) and prints each cap and each stage's spend
//   run-state.mjs override <dispatches|minutes|tokens|post_pr> "<reason>" -> a human lifts one cap for the rest of the run,
//                                                recorded with who and why; the orchestrator never calls it on its own
//   run-state.mjs snapshot                    -> unless a run file holds a credential from the env files, commits the run
//                                                dir to .factory/history/<id>/ on the base and its new run.log lines to
//                                                .factory/log.md, then removes the worktree of a finished run (its
//                                                apps brought down and its database dropped first); a stop
//                                                ends the run needs-human, prints `needs-human: <attention item>`, exits 1
//   run-state.mjs abandon                     -> ends the run abandoned; its branch is kept, and the snapshot after it
//                                                removes a clean worktree
//   run-state.mjs status                      -> one line per run not finished (needs-human and failed wait on a resume),
//                                                from every run worktree's state.json
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readJson, arg, git, gitError, mainRoot, worktreesDir, runPaths, runContext, commitToBase, envLines, frontier, STATUS_LINE, ticketWorktree, ticketBranch, events, atUsageLimit } from "./lib.mjs";

const ROUTES = ["oneshot", "build", "answer", "hold", "map"];
const OUTCOMES = ["delivered", "needs-human", "failed", "abandoned", "answered", "charted", "suspended"];
const FINISHED = ["delivered", "abandoned", "answered", "charted"];
const WAITING = ["needs-human", "failed", "suspended"];  // outcomes that wait on a resume; suspended: a usage-limit stop
const OUTPUT = {  // the file each stage writes in the run dir
  triage: "triage.md", answer: "answer.md", research: "research.md", spec: "spec.md", "builder-check": "builder-check.md",
  tickets: "tickets",  // a folder
};
// the file a stage of one ticket, <stage>:<NN>, writes in tickets/<NN>/: the planner's plan, the implementer's report,
// the researcher's answer to the implementer and qa's walk
const TICKET_OUTPUT = { plan: "plan.md", implement: "implementation.md", context: "context.md", qa: "qa.json" };
const BEFORE_SPEC_GATE = ["triage", "research", "spec", "builder-check"];  // a build run's only stages before its spec is approved
const TICKET_STATUSES = ["ready-for-agent", "in-progress", "done", "blocked"];
const CREDENTIAL = /KEY|SECRET|TOKEN|PASS|PWD|PRIVATE|CREDENTIAL|AUTH|DSN/i;  // an env name whose value the snapshot withholds

const argv = process.argv.slice(2);
const cmd = argv[0];
const args = argv.slice(1).filter((a, i, all) => !a.startsWith("--") && !["--run", "--agent", "--log", "--pid", "--session"].includes(all[i - 1]));
const now = () => new Date().toISOString();

function die(msg) { console.error(`run-state: ${msg}`); process.exit(2); }
function save(file, s) { s.updated_at = now(); fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n"); }
const log = (runDir, line) => fs.appendFileSync(path.join(runDir, "run.log"), `- ${now()} ${line}\n`);
const readText = (file) => fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
// An approval covers spec.md exactly as the human read it: any later change to the file needs approving again, but for
// the Notion page's URL that `notion pushed` writes into its frontmatter.
const specHash = (ctx) => crypto.createHash("sha256").update(readText(path.join(ctx.runDir, "spec.md"))).digest("hex");
const specApproved = (ctx, s) => s.approvals?.spec?.sha256 === specHash(ctx);
const FRONTMATTER = /^---\n([\s\S]*?\n)?---(?:\n|$)/;  // spec.md's, its lines in [1]
// The ticket gate's approval covers every ticket's name and text. `ticket` moves it along with each Status line it
// writes, so any other change to a ticket, a status included, needs approving again.
const readTickets = (ctx) => frontier(path.join(ctx.runDir, "tickets"));
const ticketsHash = (ctx) => crypto.createHash("sha256").update(JSON.stringify(readTickets(ctx).items.map((t) => [t.id, t.text]))).digest("hex");
const ticketsApproved = (ctx, s) => s.approvals?.tickets?.sha256 === ticketsHash(ctx);
// Why a cut can't be approved: the frontier orders tickets by their Status and Blocked by lines, and a ticket waits only on
// one numbered before it.
const ticketProblems = (items) => items.flatMap((t) => [
  t.status !== "ready-for-agent" && `${t.id} isn't \`Status: ready-for-agent\``,
  !t.blockedBy && `${t.id} has no \`Blocked by:\` line`,
  items.some((u) => u !== t && u.n === t.n) && `${t.id} shares its number`,
  ...(t.blockedBy || []).filter((b) => !(b < t.n && items.some((u) => u.n === b))).map((b) => `${t.id} waits on ${b}, which doesn't come before it`),
].filter(Boolean));
function load() {
  const ctx = runContext();
  return [ctx, readJson(ctx.state)];
}
// The strings in one env assignment that must never be committed or posted, [] when it holds none: the value of a
// credential-like name, and the password in a scheme://user:password@host value, each only at 8 characters or more.
// A bare loopback address (NEXTAUTH_URL=http://localhost:3000) is in almost every run file and carries no credential;
// one with a user, query or fragment may.
function secretsIn(name, value) {
  const url = value.match(/^[a-z][a-z\d+.-]*:\/\/(?:([^/?#]*)@)?(\[[^\]]*\]|[^/:?#]*)/i);  // [, userinfo, host]
  const loopback = url && !url[1] && !/[?#]/.test(value) && /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/i.test(url[2]);
  const password = url?.[1]?.split(":").slice(1).join(":");
  return [CREDENTIAL.test(name) && !loopback && value, password].filter((v) => v && v.length >= 8);
}
// Every credential-like value in the developer's env files, as { name, file, value }: .factory/env.local and the .env*
// files the main checkout ignores. Only a value's name and file are ever printed.
function envSecrets(main) {
  const ignored = git(main, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory", "--", ":(glob)**/.env*")
    .split("\0").filter((f) => /(^|\/)\.env[^/]*$/.test(f));
  return [".factory/env.local", ...ignored].filter((f) => fs.existsSync(path.join(main, f))).flatMap((file) =>
    envLines(fs.readFileSync(path.join(main, file), "utf8")).flatMap(([name, v]) => secretsIn(name, v).map((value) => ({ name, file, value }))));
}
// A snapshot that stops: writes <run_dir>/attention-<name>.md in the factory skill's attention-item shape, ends the run
// needs-human with its worktree kept, prints the item's path and exits 1.
function stop(ctx, s, name, { headline, happened, evidence, recommendation, options }) {
  const file = path.join(ctx.runDir, `attention-${name}.md`);
  fs.writeFileSync(file, `# ${headline}\n\nRun \`${ctx.id}\`, stage \`snapshot\`.\n\n## What happened\n${happened}\n\n`
    + `## Evidence\n${evidence.map((e) => `- \`${e}\``).join("\n")}\n\n## Recommendation\n${recommendation}\n\n`
    + `## Options\n${options.map(([command, what]) => `- \`${command}\`: ${what}`).join("\n")}\n`);
  s.stage = "needs-human";
  s.waiting_since ??= now();
  save(ctx.state, s);
  log(ctx.runDir, `run: ${ctx.id} needs-human`);
  console.log(`needs-human: ${file}`);
  process.exit(1);
}

// Spend is read from what Claude Code writes, never from a number an agent reports (docs/platform-facts.md, #44).
// A token is an input, cache-creation or output token. Cache reads are left out: every turn re-reads the whole context,
// so they would count it again on each turn.
const sum = (ns) => ns.reduce((a, n) => a + (n || 0), 0);
// One transcript or stream-json log: its tokens (each message once, though Claude Code writes a message once per content
// block), tool-result characters by tool, images read and compaction markers; a child's log also has its final result,
// whose per-model usage is the session's total so far, its own subagents and earlier --resume rounds included. Only
// lines typed assistant, user, system or result count: an api-request-blob repeats a request's messages. Lines stamped
// before `since` are skipped. null when the file can't be read.
function readLog(file, since) {
  let text; try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
  const m = { tokens: 0, tool_chars: {}, images: 0, compactions: 0 }, usage = new Map(), tools = new Map();
  // A line that isn't JSON, or is in a shape Claude Code doesn't write today, is skipped: a format change never stops a run.
  for (const line of text.split("\n")) try {
    const e = JSON.parse(line);
    if (since && e.timestamp < since) continue;
    const content = Array.isArray(e.message?.content) ? e.message.content : [];
    if (e.type === "system" && e.subtype === "compact_boundary") m.compactions++;
    else if (e.type === "result" && e.modelUsage) m.result = { session: e.session_id,
      tokens: sum(Object.values(e.modelUsage).map((u) => sum([u.inputTokens, u.cacheCreationInputTokens, u.outputTokens]))) };
    else if (e.type === "assistant") {
      if (e.message?.usage) usage.set(e.message.id, e.message.usage);
      for (const b of content) if (b.type === "tool_use") tools.set(b.id, b.name);
    } else if (e.type === "user") for (const b of content.filter((b) => b.type === "tool_result")) {
      const parts = typeof b.content === "string" ? [{ type: "text", text: b.content }] : b.content || [];
      const tool = tools.get(b.tool_use_id) || "unknown";
      m.tool_chars[tool] = (m.tool_chars[tool] || 0) + sum(parts.map((c) => c.type === "text" && c.text.length));
      m.images += parts.filter((c) => c.type === "image").length;
    }
  } catch {}
  m.tokens = sum([...usage.values()].map((u) => sum([u.input_tokens, u.cache_creation_input_tokens, u.output_tokens])));
  m.read = usage.size > 0 || !!m.result;
  return m;
}
// Measures the run's spend into s.spend, by stage: the orchestrator from the transcript of each session that drove the run,
// since the run started, a subagent from its own transcript beside that of the session that dispatched it, both estimates,
// and a child from its final result (each child session counted once, at its latest result). A session's folder under
// projects/ is named after the cwd it started in, so it is found by the session id.
function measure(ctx, s) {
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
  const folders = fs.existsSync(projects) ? fs.readdirSync(projects).map((d) => path.join(projects, d)) : [];
  const folder = (id) => id && folders.find((d) => fs.existsSync(path.join(d, `${id}.jsonl`)) || fs.existsSync(path.join(d, id)));
  const sessions = [...new Set([s.session, ...(s.taken_over || []).map((t) => t.from), ...s.dispatches.map((d) => d.orchestrator_session)])].filter(Boolean);
  const subagent = (d, id = d.orchestrator_session || s.session) => d.agent && folder(id) && path.join(folder(id), id, "subagents", `agent-${d.agent}.jsonl`);
  const by_stage = {}, children = new Map();
  const add = (stage, m, estimate) => {
    const x = by_stage[stage] ||= { tokens: 0, tool_chars: {}, images: 0, compactions: 0 };
    x.tokens += m.tokens;
    for (const [tool, n] of Object.entries(m.tool_chars)) x.tool_chars[tool] = (x.tool_chars[tool] || 0) + n;
    x.images += m.images;
    x.compactions += m.compactions;
    if (estimate) x.estimate = true;
  };
  let read = 0;
  for (const [stage, file, since] of [
    ...sessions.map((id) => ["orchestrator", folder(id) && path.join(folder(id), `${id}.jsonl`), s.created_at]),
    ...s.dispatches.map((d) => [d.stage, d.log || subagent(d)]),
  ]) {
    const m = file && readLog(file, since);
    if (!m?.read) continue;
    read++;
    if (m.result) children.set(m.result.session, [stage, m.result.tokens]);
    add(stage, m.result ? { ...m, tokens: 0 } : m, !m.result);
  }
  for (const [stage, tokens] of children.values()) by_stage[stage].tokens += tokens;
  const tokens = sum(Object.values(by_stage).map((x) => x.tokens));
  // tokens_at_pr: the total when pr.json was first seen; what is spent after it is the post-PR allowance's.
  const pr = s.spend?.tokens_at_pr ?? (fs.existsSync(path.join(ctx.runDir, "pr.json")) ? tokens : undefined);
  s.spend = { tokens, ...(pr !== undefined && { tokens_at_pr: pr }), by_stage, ...(!read && { unread: true }) };
}
// A session's transcript, <config dir>/projects/<folder>/<session>.jsonl, or undefined when there is none here.
function transcript(id) {
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
  try { return fs.readdirSync(projects).map((d) => path.join(projects, d, `${id}.jsonl`)).find((f) => fs.existsSync(f)); } catch {}
}
// What a dispatch's agent left: a child's stream-json log, else a subagent's transcript beside its session's.
function logOf(s, d) {
  const id = d.orchestrator_session || s.session, t = d.agent && transcript(id);
  return d.log || (t && path.join(path.dirname(t), id, "subagents", `agent-${d.agent}.jsonl`));
}
// The run's caps as [name, used, limit], from config.json's caps over the defaults. They scale with the ticket count (the
// planner's tickets/NN-slug.md files) once it is known (design fix 7). Minutes are those since init, less the time spent
// waiting on the human (needs-human, failed or suspended, until the next dispatch) and the downtime reconcile finds.
// Once pr.json exists, tokens spent after it go to their own post_pr allowance, which the tokens cap never pays for
// (design fix 13).
const CAPS = { dispatches_per_run: 30, minutes_per_run: 90, minutes_per_ticket: 45, tokens_overhead: 700_000,
  tokens_per_ticket: 700_000, tokens_per_run: 1_500_000, tokens_post_pr: 400_000, implement_rounds: 3 };
const limits = (ctx) => ({ ...CAPS, ...readJson(path.join(ctx.MAIN, ".factory", "config.json"))?.caps });
function caps(ctx, s) {
  const c = limits(ctx);
  const dir = path.join(ctx.runDir, "tickets");
  const tickets = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^\d{2}-.+\.md$/.test(f)).length : 0;
  const pr = s.spend.tokens_at_pr;
  const ran = Date.now() - Date.parse(s.created_at) - (s.waited_ms || 0) - (s.waiting_since ? Date.now() - Date.parse(s.waiting_since) : 0);
  return [
    ["dispatches", s.dispatches.length, c.dispatches_per_run],
    ["minutes", Math.floor(ran / 60000), c.minutes_per_run + c.minutes_per_ticket * Math.max(0, tickets - 1)],
    ["tokens", pr ?? s.spend.tokens, tickets ? c.tokens_overhead + c.tokens_per_ticket * tickets : c.tokens_per_run],
    ...(pr === undefined ? [] : [["post_pr", s.spend.tokens - pr, c.tokens_post_pr]]),
  ];
}
const LIFTS = ["dispatches", "minutes", "tokens", "post_pr"];  // the caps override lifts
const UNREAD = "only the minute and dispatch caps apply";
// Each stage's spend, one line each, as the BUDGET refusal and `spend` print it.
const breakdown = (spend) => Object.entries(spend.by_stage).map(([stage, x]) => `  ${stage}: ${x.tokens} tokens${x.estimate ? " (estimate)" : ""}; `
  + `tool results ${Object.entries(x.tool_chars).map(([t, n]) => `${t} ${n}`).join(", ") || "none"} chars; ${x.images} images; ${x.compactions} compactions`);

switch (cmd) {
  case "init": {
    const MAIN = mainRoot();
    const config = readJson(path.join(MAIN, ".factory", "config.json"));
    if (!config) die("no .factory/config.json: run /setup-factory first");
    const request = fs.readFileSync(0, "utf8").trim();
    if (!request) die("init reads the request on stdin");
    // An unattended run (claude -p) answers its grill from this file, which the run keeps as grill-answers.md.
    const answersFile = process.env.FACTORY_GRILL_ANSWERS;
    let answers; try { answers = answersFile && fs.readFileSync(answersFile, "utf8"); } catch { die(`no grill answers at ${answersFile}`); }
    // Before triage picks a lane, a run sits at the tip of the branch most lanes start from.
    const branching = config.branching || {};
    const base = branching.model === "git-flow" ? branching.develop || "develop" : branching.main || "main";
    let sha; try { sha = git(MAIN, "rev-parse", "--verify", `refs/heads/${base}^{commit}`); } catch { die(`base branch '${base}' doesn't exist`); }
    const slug = request.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).slice(0, 4).join("-").slice(0, 32).replace(/-$/, "") || "run";
    // mkdir is the claim, so two runs started at once never take the same id; git worktree add accepts the empty dir.
    fs.mkdirSync(worktreesDir(MAIN), { recursive: true });
    let id;
    for (let n = 1; ; n++) {
      id = `${now().slice(0, 10)}-${slug}${n > 1 ? `-${n}` : ""}`;
      try { fs.mkdirSync(path.join(worktreesDir(MAIN), id)); break; } catch (e) { if (e.code !== "EEXIST") throw e; }
    }
    const { worktree, runDir, state } = runPaths(MAIN, id);
    git(MAIN, "worktree", "add", "-q", "--detach", worktree, sha);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "prompt.md"), request + "\n");
    if (answersFile) fs.writeFileSync(path.join(runDir, "grill-answers.md"), answers);
    const s = {
      id, request, session: process.env.CLAUDE_CODE_SESSION_ID || null,
      stage: "start", route: null, base_branch: base, base_sha: sha, worktree, run_dir: runDir,
      dispatches: [], stages_done: [], created_at: now(),
    };
    save(state, s);
    log(runDir, `run: ${id} started`);
    console.log(JSON.stringify(s, null, 2));
    break;
  }
  case "get": { const [, s] = load(); console.log(JSON.stringify(s, null, 2)); break; }
  case "set": {
    const [key, raw] = args;
    if (!key || raw === undefined) die("set <key> <value>");
    let value = raw; try { value = JSON.parse(raw); } catch {}
    if (key === "route" && !ROUTES.includes(value)) die(`route is one of ${ROUTES.join(" | ")}`);
    if (key === "stage" && (!OUTCOMES.includes(value) || value === "abandoned")) {
      die(`set stage takes an outcome: ${OUTCOMES.filter((o) => o !== "abandoned").join(" | ")} (abandon and dispatch set the others)`);
    }
    const [ctx, s] = load();
    // A run that needed a cap lifted never ends delivered, so it never merges on its own (design fix 12).
    const lifted = key === "stage" && value === "delivered" ? Object.keys(s.overrides || {}) : [];
    if (lifted.length) { value = "needs-human"; console.log(`a human overrode ${lifted.join(", ")}: the run ends needs-human`); }
    // A stage whose agent stopped at the usage limit wrote nothing for the want of usage, not for a fault of the factory.
    const stalled = key === "stage" && value === "failed" && s.dispatches.at(-1);
    if (stalled && atUsageLimit(logOf(s, stalled))) { value = "suspended"; console.log(`${stalled.stage} stopped at the usage limit: the run is suspended, not failed`); }
    if (key === "stage" && WAITING.includes(value)) s.waiting_since ??= now();
    s[key] = value;
    save(ctx.state, s);
    if (key === "stage") log(ctx.runDir, `run: ${ctx.id} ${value}`);
    console.log(`ok ${key}`);
    break;
  }
  case "dispatch": {
    const [stage] = args;
    if (!stage) die("dispatch <stage> [--agent <id> | --log <path> --pid <pid> --session <id>]");
    const [ctx, s] = load();
    if (FINISHED.includes(s.stage)) die(`run ${ctx.id} is ${s.stage}`);
    if (s.route === "build" && !BEFORE_SPEC_GATE.includes(stage) && !specApproved(ctx, s)) {
      die(`the spec of ${ctx.id} isn't approved: /factory approve ${ctx.id} approved`);
    }
    if (s.route === "build" && ![...BEFORE_SPEC_GATE, "tickets"].includes(stage) && !ticketsApproved(ctx, s)) {
      die(`the tickets of ${ctx.id} aren't approved: /factory approve ${ctx.id} approved`);
    }
    const agent = arg("--agent"), childLog = arg("--log") && path.resolve(arg("--log"));
    const child = childLog && { log: childLog, ...(arg("--pid") && { pid: Number(arg("--pid")) }), ...(arg("--session") && { session: arg("--session") }) };
    const last = s.dispatches.at(-1);
    if ((agent || child) && last?.stage === stage && !last.agent && !last.log) Object.assign(last, agent && { agent }, child);
    else {
      // A dispatch ends any wait on the human, which the minute cap doesn't count.
      if (s.waiting_since) { s.waited_ms = (s.waited_ms || 0) + Date.now() - Date.parse(s.waiting_since); delete s.waiting_since; }
      // Spend is measured and the caps checked here, between dispatches only: nothing stops a stage already running.
      measure(ctx, s);
      const warned = s.warned ||= {}, crossed = [];
      for (const [name, used, limit] of caps(ctx, s)) {
        if (s.overrides?.[name]) continue;
        if (used >= limit) crossed.push(`BUDGET ${name} ${used}/${limit}: ${stage} not dispatched`);
        // once per cap and limit: a cap that scales with the ticket count can warn again
        else if (used >= 0.7 * limit && warned[name] !== limit) { warned[name] = limit; console.log(`WARN 70% of the ${name} cap: ${used}/${limit}`); }
      }
      if (s.spend.unread && !warned.spend) { warned.spend = true; console.log(`WARN spend: no usage read from any transcript, so ${UNREAD}`); }
      if (crossed.length) { save(ctx.state, s); console.log([...crossed, ...breakdown(s.spend)].join("\n")); process.exit(4); }
      const [name, n] = stage.split(":"), file = n ? TICKET_OUTPUT[name] && path.join("tickets", n, TICKET_OUTPUT[name]) : OUTPUT[name];
      const out = file && path.join(ctx.runDir, file);
      if (out && fs.existsSync(out)) {
        const round = s.dispatches.filter((d) => d.stage === stage).length;
        fs.renameSync(out, out.replace(/(\.md|\.json)?$/, `.round${round}$1`));  // tickets/ moves aside whole
      }
      // orchestrator_session: the session dispatching, beside whose transcript a subagent's is written
      // fix: the fix round this attempt is for, as `round` counted it
      const session = process.env.CLAUDE_CODE_SESSION_ID, wt = n && ticketWorktree(ctx.MAIN, ctx.id, n), fix = s.rounds?.[stage]?.n;
      s.dispatches.push({ stage, sha: git(wt && fs.existsSync(wt) ? wt : ctx.worktree, "rev-parse", "HEAD"), at: now(), ...(fix && { round: fix }),
        ...(agent && { agent }), ...child, ...(session && { orchestrator_session: session }) });
      s.stages_done = s.stages_done.filter((d) => d !== stage);
    }
    s.stage = stage;
    save(ctx.state, s);
    console.log(`dispatched ${stage} #${s.dispatches.length}${agent ? ` agent ${agent}` : ""}`);
    break;
  }
  case "round": {
    const [loop] = args, n = loop?.match(/^implement:(\d{2})$/)?.[1];
    if (!n) die("round implement:<NN>");
    const [ctx, s] = load();
    if (FINISHED.includes(s.stage)) die(`run ${ctx.id} is ${s.stage}`);
    const last = s.dispatches.findLast((d) => d.stage === loop);
    if (!last) die(`${loop} hasn't been dispatched`);
    const cap = limits(ctx).implement_rounds;
    const r = s.rounds?.[loop] || { n: 0 }, escalate = (why) => { log(ctx.runDir, `escalation: ${loop} ${why}`); console.log(`ESCALATE ${loop}: ${why}`); process.exit(5); };
    // A round counted since the last attempt is the next attempt's: a resume that asks again (after a stop between this
    // and the attempt) doesn't pay for it twice.
    if (r.n > (last.round || 0)) { console.log(`OK ${loop} round ${r.n}/${cap}`); break; }
    // An attempt counts as a round only when it produced commits: one that crashed or made nothing costs nothing.
    // ponytail: such attempts are free and unlimited, bounded only by the run's dispatch, minute and token caps; count
    // them in a row if a stuck child ever burns a run's budget that way.
    let made = 0; try { made = Number(git(ctx.MAIN, "rev-list", "--count", `${last.sha}..refs/heads/${ticketBranch(ctx.id, n)}`)); } catch {}
    if (!made) { console.log(`OK ${loop} round ${r.n}/${cap}: the last attempt made no commits, so it cost no round`); break; }
    // The failure's signature: the checks that didn't pass and their digests, numbers masked so timings and ports don't
    // count. The same one twice in a row means the round changed nothing.
    // ponytail: two reds that differ only in a number (a count, an actual value) read as the same and escalate early;
    // mask only timings and ports if that ever ends a round that was making progress.
    const ev = readJson(path.join(ctx.runDir, "tickets", n, "evidence.json"));
    let head = null; try { head = git(ctx.MAIN, "rev-parse", `refs/heads/${ticketBranch(ctx.id, n)}`); } catch {}
    const signature = ev && !ev.green && ev.sha === head ? crypto.createHash("sha256").update(JSON.stringify(ev.checks.filter((c) => c.status !== "pass")
      .map((c) => [c.app, c.check, c.status, String(c.digest).replace(/^full output: .*$/m, "").replace(/\d+/g, "#")]))).digest("hex") : null;
    if (signature && signature === r.signature) escalate(`the same failure as round ${r.n}`);
    if (r.n >= cap) escalate(`rounds ${r.n}/${cap}`);
    s.rounds = { ...s.rounds, [loop]: { n: r.n + 1, cap, signature } };  // cap: run-stage starts the last round fresh
    save(ctx.state, s);
    log(ctx.runDir, `run: ${ctx.id} ${loop} round ${r.n + 1}/${cap}`);
    console.log(`OK ${loop} round ${r.n + 1}/${cap}`);
    break;
  }
  case "done": {
    const [stage] = args;
    if (!stage) die("done <stage>");
    const [ctx, s] = load();
    if (!s.stages_done.includes(stage)) s.stages_done.push(stage);
    save(ctx.state, s);
    console.log(`done ${stage}`);
    break;
  }
  case "lane": {
    const [ctx, s] = load();
    if (s.branch) { console.log(`on ${s.branch} from ${s.base_branch} at ${s.base_sha}`); break; }
    if (!["build", "oneshot"].includes(s.route)) die(`only a build or oneshot run takes a lane; ${ctx.id} routes ${s.route}`);
    const block = [...(readText(path.join(ctx.runDir, "triage.md")).matchAll(/```json\s*\n([\s\S]*?)\n```/g))].at(-1);
    let triage; try { triage = JSON.parse(block[1]); } catch { die("triage.md has no json block that parses"); }
    // The lane comes from the type and the branching model, never from triage's prefix; only the slug is triage's. Every
    // lane but a hotfix starts from the base init chose.
    const branching = readJson(path.join(ctx.MAIN, ".factory", "config.json"), {}).branching || {};
    const prefixes = { feature: "feature/", bugfix: "bugfix/", hotfix: "hotfix/", ...branching.prefixes };
    const bug = branching.model === "git-flow" && triage.type === "bug", hotfix = bug && triage.in_production;
    const kind = hotfix ? "hotfix" : bug ? "bugfix" : "feature", base = hotfix ? branching.main || "main" : s.base_branch;
    const words = (v) => String(v ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const key = words(s.request_issue?.key), slug = words(String(triage.branch ?? "").split("/").pop());
    if (key.length && key.every((w, i) => slug[i] === w)) slug.splice(0, key.length);  // a key triage already wrote
    if (!slug.length) die("triage.md names no branch");
    const want = prefixes[kind] + [...key, ...slug.slice(0, 5)].join("-");
    let sha; try { sha = git(ctx.MAIN, "rev-parse", "--verify", `refs/heads/${base}^{commit}`); } catch { die(`base branch '${base}' doesn't exist`); }
    // A name taken here or on a remote gets the next free number; losing a race to another run moves on the same way.
    const taken = (name, refs = [`refs/heads/${name}`, `refs/remotes/*/${name}`]) => git(ctx.MAIN, "for-each-ref", "--format=x", ...refs) !== "";
    for (let n = 1; !s.branch; n++) {
      const name = n > 1 ? `${want}-${n}` : want;
      if (taken(name)) continue;
      try { git(ctx.worktree, "switch", "-q", "-c", name, sha); s.branch = name; }
      catch (e) { if (!taken(name, [`refs/heads/${name}`])) die(`can't make ${name}: ${gitError(e)}`); }
    }
    Object.assign(s, { base_branch: base, target_branch: base, base_sha: sha });
    save(ctx.state, s);
    log(ctx.runDir, `run: ${ctx.id} on ${s.branch} from ${base} at ${sha.slice(0, 7)}`);
    console.log(`on ${s.branch} from ${base} at ${sha}`);
    break;
  }
  case "approve": {
    const [gate, decision] = args;
    if (!["spec", "tickets"].includes(gate) || !["approved", "revise"].includes(decision)) die("approve spec|tickets approved | revise (a gate's abandon is abandon)");
    const [ctx, s] = load();
    if (FINISHED.includes(s.stage)) die(`run ${ctx.id} is ${s.stage}`);
    // The gate: the spec and the builder check are done, and nothing has been dispatched since. The ticket gate follows
    // the tickets in the same way, with the spec still approved.
    const before = gate === "spec" ? ["spec", "builder-check"] : ["tickets"], spec = path.join(ctx.runDir, "spec.md");
    const written = gate === "spec" ? fs.existsSync(spec) : readTickets(ctx).items.length > 0;
    if (!before.includes(s.dispatches.at(-1)?.stage) || !before.every((d) => s.stages_done.includes(d)) || !written) {
      die(`${ctx.id} isn't at the ${gate === "spec" ? "spec gate, which follows the builder check" : "ticket gate, which follows the tickets"}`);
    }
    if (gate === "tickets" && !specApproved(ctx, s)) die(`the spec of ${ctx.id} changed after its approval`);
    const problems = gate === "tickets" && decision === "approved" ? ticketProblems(readTickets(ctx).items) : [];
    if (problems.length) die(`the tickets can't be approved: ${problems.join("; ")}`);
    const hash = gate === "spec" ? specHash : ticketsHash;
    s.approvals = { ...s.approvals, [gate]: decision === "approved" ? { sha256: hash(ctx), at: now() } : undefined };
    save(ctx.state, s);
    log(ctx.runDir, `run: ${ctx.id} ${gate} ${decision}`);
    console.log(`${gate} ${decision}`);
    break;
  }
  case "ticket": {
    const [n, status] = args;
    if (!n || !TICKET_STATUSES.includes(status)) die(`ticket <NN> <${TICKET_STATUSES.join(" | ")}>`);
    const [ctx, s] = load();
    if (FINISHED.includes(s.stage)) die(`run ${ctx.id} is ${s.stage}`);
    if (!ticketsApproved(ctx, s)) die(`the tickets of ${ctx.id} aren't approved: /factory approve ${ctx.id} approved`);
    const t = readTickets(ctx).items.find((t) => t.n === n || t.id === n);
    if (!t) die(`no ticket ${n} in ${ctx.id}`);
    fs.writeFileSync(t.file, t.text.replace(STATUS_LINE, `$1${status}`));
    s.approvals.tickets.sha256 = ticketsHash(ctx);
    save(ctx.state, s);
    log(ctx.runDir, `run: ${ctx.id} ticket ${t.id} ${t.status} -> ${status}`);
    console.log(`ticket ${t.id} ${status}`);
    break;
  }
  case "next-ticket": {
    const [ctx, s] = load();
    if (!ticketsApproved(ctx, s)) die(`the tickets of ${ctx.id} aren't approved: /factory approve ${ctx.id} approved`);
    const { open, next, done } = readTickets(ctx);
    if (!open.length) console.log("DONE");
    else if (next.length) for (const t of next) console.log(`NEXT ${t.id}`);
    else for (const t of open) {
      const waits = (t.blockedBy || []).filter((b) => !done.has(b));
      console.log(`BLOCKED ${t.id}: ${t.status === "ready-for-agent" ? `waits on ${waits.join(", ")}` : t.status}`);
    }
    break;
  }
  case "notion": {
    const [what, detail] = args;
    const [ctx, s] = load();
    // Only an approved spec is copied, so a route without one never reaches Notion.
    if (!specApproved(ctx, s)) die(`the spec of ${ctx.id} isn't approved, and only an approved spec goes to Notion`);
    // A push is best effort: its failure is one line in the log, and the run carries on.
    if (what === "failed") { log(ctx.runDir, `run: ${ctx.id} spec not copied to Notion: ${detail || "no reason given"}`); console.log("logged"); break; }
    if (what === "pushed") {
      if (!/^https:\/\/\S+$/.test(detail || "")) die("notion pushed <the page's URL>");
      // The URL goes into the frontmatter, and the approval is moved to the spec with it: this is the one change to an
      // approved spec that doesn't need approving again, made only while the approval still covers the rest.
      const file = path.join(ctx.runDir, "spec.md"), text = readText(file), fm = text.match(FRONTMATTER);
      const lines = (fm?.[1] ?? "").split("\n").slice(0, -1).filter((l) => !l.startsWith("notion:"));
      fs.writeFileSync(file, `---\n${[...lines, `notion: ${detail}`].join("\n")}\n---\n${fm ? text.slice(fm[0].length) : `\n${text}`}`);
      s.notion_page = detail;
      s.approvals.spec.sha256 = specHash(ctx);
      save(ctx.state, s);
      log(ctx.runDir, `run: ${ctx.id} spec copied to Notion: ${detail}`);
      console.log(`notion: ${detail} in spec.md`);
      break;
    }
    if (what) die("notion [pushed <url> | failed \"<why>\"]");
    const config = readJson(path.join(ctx.MAIN, ".factory", "config.json"), {});
    if (config.docs !== "notion" || !config.notion_parent) { console.log("skip: .factory/config.json names no Notion parent page"); break; }
    const text = readText(path.join(ctx.runDir, "spec.md")), body = text.replace(FRONTMATTER, "").replace(/^\n+/, "");
    const title = body.match(/^# (.+)$/m)?.[1].trim();
    console.log(JSON.stringify({
      parent: config.notion_parent, page: s.notion_page ?? null, title: title ? `${title} (${ctx.id})` : ctx.id,
      content: `Copy of \`spec.md\` from run \`${ctx.id}\`. Edits and comments here are not read by the factory.\n\n${body}`,
    }, null, 2));
    break;
  }
  case "abandon": {
    const [ctx, s] = load();
    if (FINISHED.includes(s.stage)) die(`run ${ctx.id} is already ${s.stage}`);
    s.stage = "abandoned";
    save(ctx.state, s);
    log(ctx.runDir, `run: ${ctx.id} abandoned`);
    console.log(`abandoned ${ctx.id}; its branch is kept`);
    break;
  }
  case "snapshot": {
    const [ctx, s] = load();
    // A stop ends the run needs-human, so trying again first ends it the way it was ending.
    const me = `node "${process.argv[1]}"`, ending = s.stage === "abandoned" ? "abandon" : `set stage ${s.stage}`;
    const options = [
      [`${me} ${ending} --run ${ctx.id} && ${me} snapshot --run ${ctx.id}`, `ends the run ${s.stage} again and retries the snapshot`],
      [`/factory abandon ${ctx.id}`, "ends the run abandoned instead, through the same snapshot"],
    ];
    const secrets = envSecrets(ctx.MAIN);
    for (const f of fs.readdirSync(ctx.runDir, { recursive: true })) {
      const file = path.join(ctx.runDir, f);
      if (!fs.statSync(file).isFile()) continue;
      const text = fs.readFileSync(file, "utf8"), hit = secrets.find((x) => text.includes(x.value));
      if (hit) stop(ctx, s, "secret", {
        headline: `A run file holds a credential, so nothing was committed to ${s.base_branch}`,
        happened: `The run was ending ${s.stage}. \`${f}\` holds the value of \`${hit.name}\` from \`${hit.file}\`, `
          + `so its snapshot to \`.factory/history/${ctx.id}/\` committed nothing.`,
        evidence: [file], recommendation: `Remove the value from \`${f}\`, then try again.`, options,
      });
    }
    // A run is snapshotted at each stop, so the copy is replaced and only the run.log lines log.md doesn't hold are added.
    const apply = (wt) => {
      const dst = path.join(wt, ".factory", "history", ctx.id), logMd = path.join(wt, ".factory", "log.md");
      fs.rmSync(dst, { recursive: true, force: true });
      fs.cpSync(ctx.runDir, dst, { recursive: true });
      const cur = fs.existsSync(logMd) ? fs.readFileSync(logMd, "utf8") : "";
      const have = new Set(cur.split("\n"));
      const fresh = fs.readFileSync(path.join(ctx.runDir, "run.log"), "utf8").split("\n").filter((l) => l && !have.has(l));
      if (fresh.length) fs.appendFileSync(logMd, (cur && !cur.endsWith("\n") ? "\n" : "") + fresh.join("\n") + "\n");
      return [dst, logMd];
    };
    let sha; try { sha = commitToBase(ctx.MAIN, s.base_branch, `factory(run): ${ctx.id} snapshot (${s.stage})`, apply); } catch (e) {
      stop(ctx, s, "snapshot", {
        headline: `The run's files couldn't be committed to ${s.base_branch}`,
        happened: `The run was ending ${s.stage}. Its snapshot to \`.factory/history/${ctx.id}/\` committed nothing: ${e.message}.`,
        evidence: [ctx.state], recommendation: "Clear what git reports, then try again.", options,
      });
    }
    console.log(sha ? `snapshot ${sha.slice(0, 7)} on ${s.base_branch}` : `snapshot unchanged on ${s.base_branch}`);
    // A finished run has nothing left to resume. Without --force, git refuses a worktree holding uncommitted work.
    if (!FINISHED.includes(s.stage)) console.log(`worktree kept (${s.stage})`);
    else {
      // Its apps go down first. Its own database goes with it, so a worktree git won't remove keeps it, and a drop
      // that fails keeps the worktree to retry from.
      const clean = !git(ctx.worktree, "status", "--porcelain");
      const apps = spawnSync(process.execPath, [path.join(path.dirname(process.argv[1]), "run-apps.mjs"), "down", ...(clean ? ["--drop"] : []), "--run", ctx.id], { encoding: "utf8" });
      if (apps.status) console.log(`worktree kept: run-apps down failed\n${apps.stdout}${apps.stderr}`.trim());
      else try { git(ctx.MAIN, "worktree", "remove", ctx.worktree); console.log("worktree removed"); }
      catch (e) { console.log(`worktree kept: ${gitError(e)}`); }
    }
    break;
  }
  case "reconcile": {
    // The resume protocol (#11, design's "Budgets, failure and recovery"), from disk alone, never an agent's memory.
    const [ctx, s] = load();
    if (FINISHED.includes(s.stage)) die(`run ${ctx.id} is ${s.stage}`);
    if (s.route === "answer") die("an answer run isn't resumed: ask again with /factory <the question>");
    const script = (name) => path.join(path.dirname(process.argv[1]), name), self = process.env.CLAUDE_CODE_SESSION_ID || null;
    // The owner, the session init recorded, may still be driving the run: the human decides whether it's gone.
    if (s.session && s.session !== self && !argv.includes("--take-over")) {
      const t = transcript(s.session), last = s.dispatches.at(-1), line = readText(path.join(ctx.runDir, "run.log")).trim().split("\n").at(-1);
      console.log([`OWNED ${ctx.id}: session ${s.session} owns it, and this is ${self ? `session ${self}` : "no known session"}`,
        `  the owner's last activity: ${t ? `${fs.statSync(t).mtime.toISOString()}, its transcript's last write (${t})` : "unknown, with no transcript of it here"}`,
        `  the run's last update: ${s.updated_at}${last ? `, its last dispatch ${last.stage} at ${last.at}` : ""}`,
        ...(line ? [`  its last log line: ${line.slice(2)}`] : []),
        `Take it over only if that session is gone: node "${process.argv[1]}" reconcile --take-over --run ${ctx.id}`].join("\n"));
      process.exit(6);
    }
    const latest = [...new Map(s.dispatches.map((d) => [d.stage, d])).values()];  // each stage's latest dispatch
    // A child still running is working, not stopped: nothing is touched under it.
    // ponytail: a PID the OS has reused since reads as running; record the child's start time if that ever bites.
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
    const running = latest.filter((d) => !s.stages_done.includes(d.stage) && d.pid && alive(d.pid));
    if (running.length) { console.log(running.map((d) => `WORKING ${d.stage}: its child, pid ${d.pid}, still runs`).join("\n")); process.exit(6); }
    const formerOwner = self && s.session !== self && s.session;
    if (formerOwner) (s.taken_over ||= []).push({ from: formerOwner, at: now() });
    if (self) s.session = self;
    // A run cut off mid-stage has waited since its last sign of life, which the minute cap doesn't count.
    // ponytail: the orchestrator's own work after its last write (a grill, say) counts as downtime; read its transcript's
    // last line if a run ever needs those minutes counted.
    const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
    if (!WAITING.includes(s.stage)) s.waited_ms = (s.waited_ms || 0) + Math.max(0, Date.now() - Math.max(Date.parse(s.updated_at), ...s.dispatches.map((d) => mtime(logOf(s, d)))));
    save(ctx.state, s);
    if (formerOwner) console.log(`taken over from session ${formerOwner}`);
    // Every stage not marked done, with no live process, stopped. A run stopped needs-human waits on the human's decision,
    // which its attention item asks for; in any other, those stages were cut off mid-flight, and are continued.
    const stopped = latest.filter((d) => !s.stages_done.includes(d.stage)), cutOff = s.stage === "needs-human" ? [] : stopped;
    const ticketOf = (d) => { const n = d.stage.match(/^implement:(\d{2})$/)?.[1], wt = n && ticketWorktree(ctx.MAIN, ctx.id, n); return wt && fs.existsSync(wt) ? { n, wt } : null; };
    const apps = spawnSync(process.execPath, [script("run-apps.mjs"), "down", "--run", ctx.id], { encoding: "utf8" });
    console.log(apps.status ? `run-apps down failed\n${apps.stdout}${apps.stderr}`.trim() : "run-apps down");
    // What a dead implementer left uncommitted is committed where it worked, so it is seen rather than lost or silently
    // kept; never .factory/, where a recipe it changed would turn trusted. N is the fix round the attempt was for, as
    // `round` counted it: 0 for the first attempt. --no-verify: a commit hook mustn't refuse half-done work.
    for (const d of stopped) {
      const t = ticketOf(d);
      if (!t || !git(t.wt, "status", "--porcelain", "--", ".", ":(exclude).factory")) continue;
      const message = `wip(factory): salvaged from round ${d.round || 0}`;
      try { git(t.wt, "add", "-A", "--", ".", ":(exclude).factory"); git(t.wt, "commit", "-q", "--no-verify", "-m", message); }
      catch (e) { die(`can't salvage ${ticketBranch(ctx.id, t.n)}: ${gitError(e)}`); }
      const sha = git(t.wt, "rev-parse", "--short", "HEAD");
      log(ctx.runDir, `run: ${ctx.id} ${d.stage} ${message} at ${sha}`);
      console.log(`salvaged ${sha} on ${ticketBranch(ctx.id, t.n)}: ${message}`);
    }
    const done = latest.filter((d) => s.stages_done.includes(d.stage)).map((d) => d.stage);
    if (done.length) console.log(`done: ${done.join(" ")}`);
    // run-stage resumes an implementer's child session when it left output, else starts a fresh child pointed at what
    // the attempt left; a subagent that left output is resumed by its agent id. A review never is, so a half-formed
    // verdict can't anchor the next one, and nor is a stage whose output a failed run judged incomplete.
    const how = (d, log = logOf(s, d)) => /^review/.test(d.stage) ? "fresh, a cut-off review is re-run fresh, never resumed"
      : /^implement:/.test(d.stage) ? `its child ${atUsageLimit(log) ? "stopped at the usage limit" : "was cut off"}`
      : s.stage === "failed" ? "fresh, its output was judged incomplete"
      : events(log).some((e) => e.type === "assistant") ? `resume agent ${d.agent}${atUsageLimit(log) ? ", stopped at the usage limit" : ""}` : "fresh";
    for (const d of cutOff) console.log(`CONTINUE ${d.stage} from ${d.sha.slice(0, 7)}: ${how(d)}`);
    // Known state, not the last agent's claim: the fast checks where the continued implementers work, else on the run
    // branch, which a run gets at its lane.
    const trees = cutOff.map(ticketOf).filter(Boolean).map((t) => [t.wt, `ticket ${t.n} `]);
    for (const [cwd, label] of trees.length ? trees : s.branch && s.stage !== "needs-human" ? [[ctx.worktree, ""]] : []) {
      const v = spawnSync(process.execPath, [script("verify.mjs"), "--fast", "--run", ctx.id], { cwd, encoding: "utf8" });
      console.log(`${label}${v.stdout.split("\n").slice(0, 2).join("\n")}`);
    }
    // The frontier, as next-ticket prints it: tickets done are already merged and stay done.
    if (ticketsApproved(ctx, s)) process.stdout.write(spawnSync(process.execPath, [process.argv[1], "next-ticket", "--run", ctx.id], { encoding: "utf8" }).stdout);
    log(ctx.runDir, `run: ${ctx.id} reconciled${formerOwner ? `, taken over from session ${formerOwner}` : ""}`);
    break;
  }
  case "status": {
    const MAIN = mainRoot(), dir = worktreesDir(MAIN);
    const runs = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
      .map((id) => readJson(runPaths(MAIN, id).state))
      .filter((s) => s && !FINISHED.includes(s.stage))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (!runs.length) console.log("no active runs");
    for (const s of runs) console.log(`${s.id}  ${s.stage}  ${s.route || "-"}  ${s.request.split("\n")[0].slice(0, 60)}${s.spend?.unread ? `  spend unread: ${UNREAD}` : ""}`);
    break;
  }
  case "override": {
    const [cap, reason] = args;
    if (!LIFTS.includes(cap) || !reason) die(`override <${LIFTS.join(" | ")}> "<reason>"`);
    const [ctx, s] = load();
    if (FINISHED.includes(s.stage)) die(`run ${ctx.id} is ${s.stage}`);
    let by = "unknown"; try { by = git(ctx.MAIN, "config", "user.name"); } catch {}
    s.overrides = { ...s.overrides, [cap]: { by, reason, at: now() } };
    save(ctx.state, s);
    log(ctx.runDir, `override ${cap} by ${by}: ${reason}`);
    console.log(`override ${cap} recorded: the cap is lifted for this run, which can no longer end delivered`);
    break;
  }
  case "spend": {
    if (args.length) die("spend takes no number: it measures the run's transcripts");
    const [ctx, s] = load();
    measure(ctx, s);
    save(ctx.state, s);
    for (const [name, used, limit] of caps(ctx, s)) console.log(`${name} ${used}/${limit}${s.overrides?.[name] ? " (lifted)" : ""}`);
    if (s.spend.unread) console.log("no usage read from any transcript");
    for (const line of breakdown(s.spend)) console.log(line);
    break;
  }
  default: die("usage: run-state.mjs init | lane | approve | notion | ticket | next-ticket | get | set | dispatch | round | done | spend | override | snapshot | reconcile | abandon | status");
}
