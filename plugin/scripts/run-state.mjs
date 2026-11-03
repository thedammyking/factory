#!/usr/bin/env node
// run-state.mjs — the only writer of a run's state.json.
// Every command but init and status takes --run <id>, or derives the run from the run worktree it runs in.
//   run-state.mjs init < request              -> the run worktree detached at the base tip, the run dir inside it with
//                                                state.json and prompt.md; records the owning session; prints the state
//   run-state.mjs get                         -> prints state.json
//   run-state.mjs set <key> <value>           -> sets a top-level key (JSON when it parses); `route` must be a route and
//                                                `stage` an outcome (dispatch sets the working stages, abandon its own);
//                                                a run with an override ends needs-human when set delivered, and the time
//                                                a run waits needs-human or failed isn't counted against its minutes
//   run-state.mjs dispatch <stage> [--agent <id> | --log <path>] -> before the agent starts: measures spend and checks the
//                                                caps, printing `WARN 70% …` once per cap, or `BUDGET <cap> <used>/<limit>`
//                                                and the spend by stage and exiting 4 without dispatching; then records the
//                                                stage, the run worktree's HEAD and the time, and moves an earlier output
//                                                aside (<name>.round<N>.md), since a dispatch with no output yet is working;
//                                                once the agent has started, --agent attaches its id to that dispatch, or
//                                                --log a child's stream-json log
//   run-state.mjs done <stage>                -> marks a stage done
//   run-state.mjs spend                       -> measures spend (it takes no number) and prints each cap and each stage's spend
//   run-state.mjs override <dispatches|minutes|tokens|post_pr> "<reason>" -> a human lifts one cap for the rest of the run,
//                                                recorded with who and why; the orchestrator never calls it on its own
//   run-state.mjs snapshot                    -> unless a run file holds a credential from the env files, commits the run
//                                                dir to .factory/history/<id>/ on the base and its new run.log lines to
//                                                .factory/log.md, then removes the worktree of a finished run; a stop
//                                                ends the run needs-human, prints `needs-human: <attention item>`, exits 1
//   run-state.mjs abandon                     -> ends the run abandoned; its branch is kept, and the snapshot after it
//                                                removes a clean worktree
//   run-state.mjs status                      -> one line per run not finished (needs-human and failed wait on a resume),
//                                                from every run worktree's state.json
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJson, arg, git, gitError, mainRoot, worktreesDir, runPaths, runContext, commitToBase } from "./lib.mjs";

const ROUTES = ["oneshot", "build", "answer", "hold", "map"];
const OUTCOMES = ["delivered", "needs-human", "failed", "abandoned", "answered", "charted"];
const FINISHED = ["delivered", "abandoned", "answered", "charted"];
const WAITING = ["needs-human", "failed"];  // outcomes that wait on a resume
const OUTPUT = { triage: "triage.md", answer: "answer.md" };  // the file each stage writes in the run dir
const CREDENTIAL = /KEY|SECRET|TOKEN|PASS|PWD|PRIVATE|CREDENTIAL|AUTH|DSN/i;  // an env name whose value the snapshot withholds

const argv = process.argv.slice(2);
const cmd = argv[0];
const args = argv.slice(1).filter((a, i, all) => !a.startsWith("--") && !["--run", "--agent", "--log"].includes(all[i - 1]));
const now = () => new Date().toISOString();

function die(msg) { console.error(`run-state: ${msg}`); process.exit(2); }
function save(file, s) { s.updated_at = now(); fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n"); }
const log = (runDir, line) => fs.appendFileSync(path.join(runDir, "run.log"), `- ${now()} ${line}\n`);
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
    fs.readFileSync(path.join(main, file), "utf8").split("\n").flatMap((line) => {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*=\s*(.*)$/);
      if (!m) return [];
      const quoted = m[2].trim().match(/^(["'])(.*)\1$/);
      return secretsIn(m[1], quoted ? quoted[2] : m[2].replace(/\s+#.*$/, "").trim()).map((value) => ({ name: m[1], file, value }));
    }));
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
  const sessions = [...new Set([s.session, ...s.dispatches.map((d) => d.orchestrator_session)])].filter(Boolean);
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
// The run's caps as [name, used, limit], from config.json's caps over the defaults. They scale with the ticket count (the
// planner's tickets/NN-slug.md files) once it is known (design fix 7). Minutes are those since init, less the time spent
// waiting on the human (needs-human or failed, until the next dispatch). Once pr.json exists, tokens spent after it go to
// their own post_pr allowance, which the tokens cap never pays for (design fix 13).
const CAPS = { dispatches_per_run: 30, minutes_per_run: 90, minutes_per_ticket: 45, tokens_overhead: 700_000,
  tokens_per_ticket: 700_000, tokens_per_run: 1_500_000, tokens_post_pr: 400_000 };
function caps(ctx, s) {
  const c = { ...CAPS, ...readJson(path.join(ctx.MAIN, ".factory", "config.json"))?.caps };
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
    if (key === "stage" && WAITING.includes(value)) s.waiting_since ??= now();
    s[key] = value;
    save(ctx.state, s);
    if (key === "stage") log(ctx.runDir, `run: ${ctx.id} ${value}`);
    console.log(`ok ${key}`);
    break;
  }
  case "dispatch": {
    const [stage] = args;
    if (!stage) die("dispatch <stage> [--agent <id> | --log <path>]");
    const [ctx, s] = load();
    if (FINISHED.includes(s.stage)) die(`run ${ctx.id} is ${s.stage}`);
    const agent = arg("--agent"), childLog = arg("--log") && path.resolve(arg("--log"));
    const last = s.dispatches.at(-1);
    if ((agent || childLog) && last?.stage === stage && !last.agent && !last.log) Object.assign(last, agent && { agent }, childLog && { log: childLog });
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
      const out = OUTPUT[stage] && path.join(ctx.runDir, OUTPUT[stage]);
      if (out && fs.existsSync(out)) {
        const round = s.dispatches.filter((d) => d.stage === stage).length;
        fs.renameSync(out, out.replace(/\.md$/, `.round${round}.md`));
      }
      // orchestrator_session: the session dispatching, beside whose transcript a subagent's is written
      const session = process.env.CLAUDE_CODE_SESSION_ID;
      s.dispatches.push({ stage, sha: git(ctx.worktree, "rev-parse", "HEAD"), at: now(), ...(agent && { agent }), ...(childLog && { log: childLog }), ...(session && { orchestrator_session: session }) });
      s.stages_done = s.stages_done.filter((d) => d !== stage);
    }
    s.stage = stage;
    save(ctx.state, s);
    console.log(`dispatched ${stage} #${s.dispatches.length}${agent ? ` agent ${agent}` : ""}`);
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
    else try { git(ctx.MAIN, "worktree", "remove", ctx.worktree); console.log("worktree removed"); }
    catch (e) { console.log(`worktree kept: ${gitError(e)}`); }
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
  default: die("usage: run-state.mjs init | get | set | dispatch | done | spend | override | snapshot | abandon | status");
}
