#!/usr/bin/env node
// preview.mjs [--wait <s>] [--poll <s>] | try [--done] — after the PR opens, writes preview.json: where each app's preview
// of the run head is, as the project's host or recipe has it, never built here. `try` is /factory try (see tryIt below).
// Takes --run <id>, or derives the run from the run worktree it runs in. Each app of the recipe gets { mode, touched,
// status ready|failed|timeout|none, sha, url, reason } by its setup.json `preview` entry, local when it has none. An app
// the run doesn't touch is none, waiting on nothing, and so is a mobile app unless a touches.json of the head says the
// diff's `native` touch didn't fire:
//   - github-deployment: GitHub's deployments of the head in its `environment`, newest first, and each one's latest
//     status, read again every --poll seconds (15) until one reports success with an environment_url (ready) or the
//     newest one failure or error (failed), or --wait seconds (600) run out (timeout).
//   - command: its `command`, run in the app's path within the wait; the URL is at `url_from` in the JSON it prints.
//   - fixed: its `url`, ready.
//   - local: none; the human tries it with the apps started locally.
// It never fails the run: whatever the host says, it writes preview.json and exits 0. Prints `PREVIEW <app>=<status> …`.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readJson, arg, git, gitError, mainRoot, runPaths, worktreesDir, runContext, runDiff, runEnv, githubRepo, ghApi, pause } from "./lib.mjs";

if (process.argv[2] === "try") tryIt();  // it exits

const ctx = runContext(), s = readJson(ctx.state), dir = ctx.runDir, head = git(ctx.worktree, "rev-parse", "HEAD"), short = head.slice(0, 7);
const recipe = readJson(path.join(ctx.worktree, ".factory", "setup.json"), {}), repo = githubRepo(ctx.MAIN);
const wait = Number(arg("--wait", 600)), poll = Number(arg("--poll", 15)) * 1000, deadline = Date.now() + wait * 1000;
const files = runDiff(ctx).files, logs = path.join(dir, "logs"), touches = readJson(path.join(dir, "touches.json"));
const native = touches?.head === head ? !!touches.touches?.native?.hit : null;  // null: no touches.json of the head says
const web = (url) => /^https?:\/\/\S+$/.test(url ?? "");
// as merge-decision has it: an app at the root is touched by any change, else by one under its path
const touched = (a) => [".", ""].includes(a.path ?? ".") || files.some((f) => f.startsWith(`${a.path.replace(/\/+$/, "")}/`));
const out = { run: ctx.id, sha: head, apps: {} };
const set = (a, mode, status, more = {}) => { out.apps[a.name] = { mode, touched: touched(a), status, sha: head, ...more }; };

// [status, fields] once a deployment of the head has a latest status that is success with an environment_url (ready), or
// the newest one's is failure or error (failed: an older failure waits on the newer deployment); null till then.
const refused = {};
function deployment(a, p) {
  const r = ghApi("-X", "GET", `repos/${repo}/deployments`, "-f", `sha=${head}`, ...(p.environment ? ["-f", `environment=${p.environment}`] : []), "-f", "per_page=10");
  if (!r.ok) { refused[a.name] = r.message; return null; }
  for (const [i, d] of (Array.isArray(r.json) ? r.json : []).entries()) {
    const st = ghApi(`repos/${repo}/deployments/${d.id}/statuses?per_page=1`).json?.[0];
    if (st?.state === "success" && web(st.environment_url)) return ["ready", { url: st.environment_url, deployment: d.id }];
    if (i === 0 && ["failure", "error"].includes(st?.state)) return ["failed", { reason: `deployment ${d.id} ${st.state}${st.description ? `: ${st.description}` : ""}`, deployment: d.id }];
  }
  return null;
}

// The recipe's command for the app, in its path. {branch}, {sha} and {title} reach the shell only as quoted env refs, never
// as text in the command, so nothing in a PR title runs; the recipe writes them bare, outside quotes. The URL is at
// url_from, a dotted JSON path into its stdout.
// ponytail: the wait kills bash alone, so a process it started can outlive it; give it a process group if one does.
function command(a, p) {
  const title = (fs.existsSync(path.join(dir, "pr.md")) ? fs.readFileSync(path.join(dir, "pr.md"), "utf8").split("\n")[0].replace(/^# /, "") : "") || ctx.id;
  const cmd = p.command.replace(/\{(branch|sha|title)\}/g, (_, k) => `"$FACTORY_${k.toUpperCase()}"`);
  fs.mkdirSync(logs, { recursive: true });
  const stdout = path.join(logs, `${a.name}.preview.out`), log = path.join(logs, `${a.name}.preview.log`), fds = [fs.openSync(stdout, "w"), fs.openSync(log, "w")];
  const r = spawnSync("bash", ["-c", cmd], { cwd: path.join(ctx.worktree, a.path || "."), stdio: ["ignore", ...fds], killSignal: "SIGKILL", timeout: Math.max(1, deadline - Date.now()),
    env: runEnv(ctx.MAIN, { FACTORY_BRANCH: s.branch ?? "", FACTORY_SHA: head, FACTORY_TITLE: title }) });
  fds.forEach((fd) => fs.closeSync(fd));
  if (r.error?.code === "ETIMEDOUT") return ["timeout", { reason: `the command ran past the ${wait}s wait`, log }];
  if (r.status !== 0) return ["failed", { reason: `the command exited ${r.status ?? r.signal ?? r.error?.message}`, log }];
  let url; try { url = String(p.url_from).replace(/^\$\.?/, "").split(/[.[\]]+/).filter(Boolean).reduce((o, k) => o?.[k], JSON.parse(fs.readFileSync(stdout, "utf8"))); } catch {}
  return web(url) ? ["ready", { url }] : ["failed", { reason: p.url_from ? `its output has no http(s) URL at ${p.url_from}` : "the recipe gives it no url_from", log }];
}

let deploying = [];
for (const a of recipe.apps || []) {
  const p = recipe.preview?.[a.name] ?? { mode: "local" };
  try {
    if (p.mode === "local") set(a, "local", "none");
    else if (!touched(a)) set(a, p.mode, "none", { reason: "the run doesn't touch it" });
    // an update over the air would run the new JavaScript on the old binary (#27)
    else if (a.type === "mobile" && native !== false) set(a, p.mode, "none", { reason: native ? "native change, needs a new build" : "no touches.json of the head rules out a native change" });
    else if (p.mode === "fixed") set(a, p.mode, web(p.url) ? "ready" : "failed", web(p.url) ? { url: p.url } : { reason: "the recipe gives it no http(s) url" });
    else if (p.mode === "command") set(a, p.mode, ...command(a, p));
    else if (p.mode === "github-deployment") repo ? (set(a, p.mode, "timeout"), deploying.push([a, p])) : set(a, p.mode, "none", { reason: "origin isn't a GitHub repo" });  // its place in recipe order
    else set(a, p.mode, "none", { reason: `no preview mode ${p.mode}` });
  } catch (e) { set(a, p.mode, "failed", { reason: e.message }); }
}
for (;;) {
  deploying = deploying.filter(([a, p]) => { const got = deployment(a, p); if (got) set(a, p.mode, ...got); return !got; });
  if (!deploying.length || Date.now() >= deadline) break;
  pause(Math.max(0, Math.min(poll, deadline - Date.now())));
}
for (const [a, p] of deploying) set(a, p.mode, "timeout", { reason: `no deployment of ${short}${p.environment ? ` in ${p.environment}` : ""} reported success with an environment_url in ${wait}s${refused[a.name] ? ` (GitHub: ${refused[a.name]})` : ""}` });

fs.writeFileSync(path.join(dir, "preview.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`PREVIEW ${Object.entries(out.apps).map(([n, x]) => `${n}=${x.status}${x.url ? ` ${x.url}` : ""}${x.reason ? ` (${x.reason})` : ""}`).join(" ")}\npreview.json: ${path.join(dir, "preview.json")}`);

// try [--done] --run <id>: /factory try, on a run going on or one that has ended (read from its record on the base).
//   - On the preview when preview.json has every app the run touched ready, at the PR's head as REST reads it now: prints
//     `PREVIEW at <sha>`, each app's URL and pr.md's Verify in 2 minutes steps with each route on the first touched web
//     app's preview (else the first touched app's), and opens the first route. It starts nothing.
//   - Else locally, never mixing in a preview: prints `LOCAL: <why>` (no PR, not ready, no preview or a stale head), runs
//     run-apps up in the run worktree, or, once that's gone, in <run>-try, a worktree of the PR at its head, then the
//     steps on the local apps, and opens the first route.
//   - --done brings those apps down and removes <run>-try.
// Exits 1 when the apps or the PR branch's worktree fail, 2 on bad usage.
function tryIt() {
  const MAIN = mainRoot(), id = arg("--run") ?? "", die = (msg, code = 2) => { console.error(`preview: ${msg}`); process.exit(code); };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) die("usage: preview.mjs try [--done] --run <id>");
  const run = runPaths(MAIN, id), live = fs.existsSync(run.state), temp = path.join(worktreesDir(MAIN), `${id}-try`), short = (sha) => String(sha).slice(0, 7);
  if (fs.existsSync(runPaths(MAIN, `${id}-try`).state)) die(`${temp} is run ${id}-try's worktree, so ${id} can't be tried in it`, 1);
  const apps = (cwd, ...a) => {
    const r = spawnSync(process.execPath, [fileURLToPath(new URL("run-apps.mjs", import.meta.url)), ...a], { cwd, encoding: "utf8" });
    process.stdout.write(r.stdout + r.stderr);
    return r.status === 0;
  };
  if (process.argv.includes("--done")) {
    let ok = !live || apps(MAIN, "down", "--run", id);
    if (fs.existsSync(temp)) {
      if (apps(temp, "down", "--drop")) { git(MAIN, "worktree", "remove", "--force", temp); console.log(`removed ${temp}`); } else ok = false;
    }
    process.exit(ok ? 0 : 1);
  }

  const record = live ? null : git(MAIN, "log", "--all", "-1", "--format=%H", "--", `.factory/history/${id}/state.json`);
  if (!live && !record) die(`no run ${id}`);
  const read = (f) => { try { return live ? fs.readFileSync(path.join(run.runDir, f), "utf8") : git(MAIN, "show", `${record}:.factory/history/${id}/${f}`); } catch { return ""; } };
  const json = (f) => { try { return JSON.parse(read(f)); } catch { return null; } };
  const preview = json("preview.json"), pr = json("pr.json"), got = pr && ghApi(`repos/${pr.repo}/pulls/${pr.number}`), head = got?.ok ? got.json?.head : null;
  const types = Object.fromEntries((readJson(path.join(MAIN, ".factory", "setup.json"), {}).apps || []).map((a) => [a.name, a.type]));
  const touched = Object.entries(preview?.apps || {}).filter(([, a]) => a.touched), unready = touched.filter(([, a]) => a.status !== "ready");
  const why = !pr ? "no PR is open" : !head ? `PR #${pr.number}'s head couldn't be read over REST: ${got.message}`
    : !preview ? "no preview: preview.mjs hasn't written preview.json"
    : !touched.some(([, a]) => a.mode !== "local") ? "no preview: no app the run touches has one"
    : unready.length ? `not ready: ${unready.map(([n, a]) => `${n} ${a.mode === "local" ? "has no preview" : `${a.status}${a.reason ? ` (${a.reason})` : ""}`}`).join(", ")}`
    : touched.some(([, a]) => a.sha !== head.sha) ? `stale head: the preview is of ${short(preview.sha)}, the PR's head is ${short(head.sha)}` : null;

  // pr.md's steps with each route on base, and the first route opened, else base itself
  const show = (base) => {
    const at = (route) => base.replace(/\/+$/, "") + route;
    let first = null;
    const steps = (read("pr.md").split(/^## Verify in 2 minutes\n/m)[1] ?? "").split("\n").filter((l) => /^\d+\. /.test(l));
    console.log(["Verify in 2 minutes:", ...steps.map((l) => l.replace(/open `(\/[^`]*)`/, (_, route) => { first ??= at(route); return `open \`${at(route)}\``; }))].join("\n"));
    const url = first ?? base, opener = process.platform === "darwin" ? "open" : "xdg-open";
    const r = spawnSync(opener, [url], { stdio: "ignore", timeout: 10_000 });
    console.log(r.status === 0 ? `opened ${url}` : `couldn't open ${url}: ${r.error?.message ?? `${opener} exited ${r.status}`}`);
  };
  if (!why) {
    console.log([`PREVIEW at ${short(head.sha)}, the PR's head`, ...touched.map(([n, a]) => `- ${n}: ${a.url}`)].join("\n"));
    show((touched.find(([n]) => types[n] === "web") ?? touched[0])[1].url);
    process.exit(0);
  }

  console.log(`LOCAL: ${why}`);
  let out = run.runDir, ok;
  if (live) ok = apps(MAIN, "up", "--run", id);
  else {
    if (!pr) die(`run ${id} has ended, and has no PR to try`, 1);
    // the PR's own ref, which GitHub keeps after its branch is deleted
    try {
      if (fs.existsSync(temp) && apps(temp, "down", "--drop")) git(MAIN, "worktree", "remove", "--force", temp);
      git(MAIN, "fetch", "-q", "origin", `refs/pull/${pr.number}/head`);
      git(MAIN, "worktree", "add", "-q", "--detach", temp, head?.sha ?? "FETCH_HEAD");
    } catch (e) { die(`can't make a worktree of PR #${pr.number}: ${gitError(e)}`, 1); }
    console.log(`PR #${pr.number} at ${short(git(temp, "rev-parse", "HEAD"))}, in ${temp}`);
    ok = apps(temp, "up");
    out = path.join(temp, ".factory", "runs", id);
  }
  if (!ok) die(`the apps didn't all start: preview.mjs try --done --run ${id} brings them down`, 1);
  const up = Object.entries(readJson(path.join(out, "apps.json"))?.apps || {}).filter(([, a]) => a.ok === true && a.url);
  console.log(up.map(([n, a]) => `- ${n}: ${a.url}`).join("\n"));
  const base = (up.find(([n]) => types[n] === "web") ?? up[0])?.[1].url;
  if (base) show(new URL(base).origin);
  console.log(`When you're done: preview.mjs try --done --run ${id}`);
  process.exit(0);
}
