#!/usr/bin/env node
// run-state.mjs — the only writer of a run's state.json.
// Every command but init and status takes --run <id>, or derives the run from the run worktree it runs in.
//   run-state.mjs init < request              -> the run worktree detached at the base tip, the run dir inside it with
//                                                state.json and prompt.md; records the owning session; prints the state
//   run-state.mjs get                         -> prints state.json
//   run-state.mjs set <key> <value>           -> sets a top-level key (JSON when it parses); `route` must be a route and
//                                                `stage` an outcome (dispatch sets the working stages, abandon its own)
//   run-state.mjs dispatch <stage> [--agent <id>] -> before the agent starts: records the stage, the run worktree's HEAD and
//                                                the time, and moves an earlier output aside (<name>.round<N>.md), since a
//                                                dispatch with no output yet is working; once the agent has started,
//                                                --agent attaches its id to that dispatch
//   run-state.mjs done <stage>                -> marks a stage done
//   run-state.mjs abandon                     -> ends the run abandoned; its branch and worktree are kept
//   run-state.mjs status                      -> one line per run not finished (needs-human and failed wait on a resume),
//                                                from every run worktree's state.json
import fs from "node:fs";
import path from "node:path";
import { readJson, arg, git, mainRoot, worktreesDir, runPaths, runContext } from "./lib.mjs";

const ROUTES = ["oneshot", "build", "answer", "hold", "map"];
const OUTCOMES = ["delivered", "needs-human", "failed", "abandoned", "answered", "charted"];
const FINISHED = ["delivered", "abandoned", "answered", "charted"];
const OUTPUT = { triage: "triage.md" };  // the file each stage writes in the run dir

const argv = process.argv.slice(2);
const cmd = argv[0];
const args = argv.slice(1).filter((a, i, all) => !a.startsWith("--") && !["--run", "--agent"].includes(all[i - 1]));
const now = () => new Date().toISOString();

function die(msg) { console.error(`run-state: ${msg}`); process.exit(2); }
function save(file, s) { s.updated_at = now(); fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n"); }
const log = (runDir, line) => fs.appendFileSync(path.join(runDir, "run.log"), `- ${now()} ${line}\n`);
function load() {
  const ctx = runContext();
  return [ctx, readJson(ctx.state)];
}

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
    s[key] = value;
    save(ctx.state, s);
    if (key === "stage") log(ctx.runDir, `run: ${ctx.id} ${value}`);
    console.log(`ok ${key}`);
    break;
  }
  case "dispatch": {
    const [stage] = args;
    if (!stage) die("dispatch <stage> [--agent <id>]");
    const [ctx, s] = load();
    if (FINISHED.includes(s.stage)) die(`run ${ctx.id} is ${s.stage}`);
    const agent = arg("--agent");
    const last = s.dispatches.at(-1);
    if (agent && last?.stage === stage && !last.agent) last.agent = agent;
    else {
      const out = OUTPUT[stage] && path.join(ctx.runDir, OUTPUT[stage]);
      if (out && fs.existsSync(out)) {
        const round = s.dispatches.filter((d) => d.stage === stage).length;
        fs.renameSync(out, out.replace(/\.md$/, `.round${round}.md`));
      }
      s.dispatches.push({ stage, sha: git(ctx.worktree, "rev-parse", "HEAD"), at: now(), ...(agent && { agent }) });
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
    console.log(`abandoned ${ctx.id}; its branch and worktree are kept`);
    break;
  }
  case "status": {
    const MAIN = mainRoot(), dir = worktreesDir(MAIN);
    const runs = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
      .map((id) => readJson(runPaths(MAIN, id).state))
      .filter((s) => s && !FINISHED.includes(s.stage))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (!runs.length) console.log("no active runs");
    for (const s of runs) console.log(`${s.id}  ${s.stage}  ${s.route || "-"}  ${s.request.split("\n")[0].slice(0, 60)}`);
    break;
  }
  default: die("usage: run-state.mjs init | get | set | dispatch | done | abandon | status");
}
