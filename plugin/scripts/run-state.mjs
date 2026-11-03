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
//   run-state.mjs snapshot                    -> unless a run file holds a credential from the env files, commits the run
//                                                dir to .factory/history/<id>/ on the base and its new run.log lines to
//                                                .factory/log.md, then removes the worktree of a finished run; a stop
//                                                ends the run needs-human, prints `needs-human: <attention item>`, exits 1
//   run-state.mjs abandon                     -> ends the run abandoned; its branch is kept, and the snapshot after it
//                                                removes a clean worktree
//   run-state.mjs status                      -> one line per run not finished (needs-human and failed wait on a resume),
//                                                from every run worktree's state.json
import fs from "node:fs";
import path from "node:path";
import { readJson, arg, git, gitError, mainRoot, worktreesDir, runPaths, runContext, commitToBase } from "./lib.mjs";

const ROUTES = ["oneshot", "build", "answer", "hold", "map"];
const OUTCOMES = ["delivered", "needs-human", "failed", "abandoned", "answered", "charted"];
const FINISHED = ["delivered", "abandoned", "answered", "charted"];
const OUTPUT = { triage: "triage.md", answer: "answer.md" };  // the file each stage writes in the run dir
const CREDENTIAL = /KEY|SECRET|TOKEN|PASS|PWD|PRIVATE|CREDENTIAL|AUTH|DSN/i;  // an env name whose value the snapshot withholds

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
  save(ctx.state, s);
  log(ctx.runDir, `run: ${ctx.id} needs-human`);
  console.log(`needs-human: ${file}`);
  process.exit(1);
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
    for (const s of runs) console.log(`${s.id}  ${s.stage}  ${s.route || "-"}  ${s.request.split("\n")[0].slice(0, 60)}`);
    break;
  }
  default: die("usage: run-state.mjs init | get | set | dispatch | done | snapshot | abandon | status");
}
