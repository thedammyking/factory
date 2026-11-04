#!/usr/bin/env node
// post-merge.mjs [--window <seconds>] [--every <seconds>] — the watch, run only after the factory's own merge, which
// decision.json records (#15, #28, #32). Takes --run <id>, or derives the run from the run worktree it runs in. REST only
// (`gh api`). For --window seconds (3600) at most, reading again every --every seconds (20) what hasn't settled, it checks:
//   1. CI at the merged SHA: red once a workflow run failed, green once all passed, else infra (none in the window, one
//      unfinished, cancelled or the like, or GitHub refusing to the end);
//   2. the host's deployment of the merged SHA for each app the recipe previews by github-deployment (the one deployment
//      when one app is, else the one whose environment names the app, as setup matches previews): success with an
//      environment_url, failed, or none in the window;
//   3. a probe: lib's loginWall, one GET of each deployed app's root with the recipe's smoke.headers;
//   4. the smoke set: this run's pinned tests (verify's <run>-<NN>-<slug>.spec.ts | .test.mjs), only those of its spec's
//      live-safe criteria, each in its app's path against that app's deployment. Its command alone gets the headers, as
//      FACTORY_WATCH_HEADERS (JSON), and each WATCH_X of .factory/env.local as X (lib's watchEnv); its output is kept
//      with every env.local value in it as {env:<name>}.
// The smoke is blocked, never red, on a login wall at any app, on a test user the recipe declares (smoke.test_user) with
// no WATCH_ value, or on a test failing at the shared sign-in step, whose error carries FACTORY_SIGN_IN_FAILED; blocked
// changes nothing. A test that never finished (a timeout, or no runner) is infra, which isn't red either.
// Red, CI red or a test failing after sign-in, opens a `git revert` of the merge (-m 1 for a merge commit) on
// revert/<run>-<sha>, labelled factory and needs-human and never merged here, writes attention-post-merge.md and ends the
// run needs-human through run-state. The result is post-merge.json and one `post-merge:` line in run.log, which the
// snapshot adds to log.md. It reads no error-rate source and deploys nothing. Prints `POST-MERGE <the line>`, then a red
// test's digest; exits 1 on red, 2 when it can't start.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readJson, arg, git, gitError, runContext, worktreesDir, liveBase, pause, ghApi, digest, attentionItem, watchEnv, smokeHeaders, loginWall } from "./lib.mjs";

const die = (msg) => { console.error(`post-merge: ${msg}`); process.exit(2); };
const WINDOW = Number(arg("--window", 3600)), EVERY = Number(arg("--every", 20));
if (!(WINDOW >= 0 && EVERY >= 0)) die("--window and --every take seconds");
const ctx = runContext(), s = readJson(ctx.state), dir = ctx.runDir, at = (f) => path.join(dir, f);
const decision = readJson(at("decision.json")), pr = readJson(at("pr.json"));
if (!decision?.merged || !pr) die("decision.json records no merge: the watch runs only after the factory's own merge");
const sha = decision.merged, short = sha.slice(0, 7), target = s.target_branch, repo = pr.repo;
const start = Date.now(), end = start + WINDOW * 1000, waited = () => `${Math.round((Date.now() - start) / 1000)} s`;
const recipe = readJson(path.join(ctx.worktree, ".factory", "setup.json"), {});
const SIGN_IN = "FACTORY_SIGN_IN_FAILED", OK = ["success", "neutral", "skipped"];

// 1. { state, why } once CI settles, else null; a refusal is tried again at the next read
// ponytail: workflows that run only on pull_request never run at a merge commit, so CI waits out the window as infra;
// read the merged PR's head runs if such a project ever wants the hour back. One page of 100 runs, as ci-watch reads.
let runs = [], ciRefused = null;
function readCi() {
  const r = ghApi(`repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`);
  if (!r.ok) { ciRefused = r.message; return null; }
  runs = r.json?.workflow_runs ?? [];
  const red = runs.filter((w) => w.conclusion === "failure"), stuck = runs.filter((w) => !OK.includes(w.conclusion));
  if (red.length) return { state: "red", why: `CI is red at ${short}: ${red.map((w) => `${w.name} failed (${w.html_url})`).join(", ")}` };
  if (!runs.length || runs.some((w) => w.status !== "completed")) return null;
  return stuck.length ? { state: "infra", why: `CI at ${short} reached no result: ${stuck.map((w) => `${w.name} ${w.conclusion}`).join(", ")}` }
    : { state: "green", why: `${runs.length} workflow run${runs.length > 1 ? "s" : ""} passed at ${short}` };
}

// 2. each hosted app's deployment of the merged SHA, { status success|failed|none, url, reason }, null while unsettled
const hosted = (recipe.apps || []).filter((a) => recipe.preview?.[a.name]?.mode === "github-deployment");
const deployments = Object.fromEntries(hosted.map((a) => [a.name, null]));
let deployRefused = null;
function readDeployments() {
  const r = ghApi(`repos/${repo}/deployments?sha=${sha}&per_page=100`);
  if (!r.ok) { deployRefused = r.message; return; }
  const all = Array.isArray(r.json) ? r.json : [];
  for (const a of hosted.filter((a) => !deployments[a.name])) {
    const its = hosted.length === 1 ? all : all.filter((d) => String(d.environment).toLowerCase().includes(a.name.toLowerCase()));
    for (const [i, d] of its.entries()) {
      const st = ghApi(`repos/${repo}/deployments/${d.id}/statuses?per_page=1`).json?.[0];
      if (st?.state === "success" && /^https?:\/\/\S+$/.test(st.environment_url ?? "")) { deployments[a.name] = { status: "success", url: st.environment_url, deployment: d.id }; break; }
      if (i === 0 && ["failure", "error"].includes(st?.state)) { deployments[a.name] = { status: "failed", deployment: d.id, reason: `deployment ${d.id} ${st.state}` }; break; }
    }
  }
}

// 3 and 4. { state pass | fail | blocked | skipped | infra, why, tests }
const smokeEnv = watchEnv(ctx.MAIN), headers = smokeHeaders(recipe, smokeEnv);
// What the smoke's output may hold that nobody may read: every env.local value of 8 characters or more, as the snapshot
// withholds them, and the test user's and the headers' at any length. Longest first, each as {env:<its name>}.
const always = [...[].concat(recipe.smoke?.test_user ?? []), ...Object.values(recipe.smoke?.headers || {}).flatMap((v) => [...String(v).matchAll(/\{env:([^}]+)\}/g)].map((m) => m[1]))];
const secrets = Object.entries(smokeEnv).filter(([k, v]) => !["PATH", "HOME", "TMPDIR"].includes(k) && v && (String(v).length >= 8 || always.includes(k)))
  .sort(([, a], [, b]) => b.length - a.length);
const redact = (text) => secrets.reduce((t, [k, v]) => t.replaceAll(v, `{env:${k}}`), text);
const RUNNERS = { ".spec.ts": 'npx --no playwright test "$FACTORY_PINNED" --grep "$FACTORY_GREP"', ".test.mjs": 'node --test --test-name-pattern "$FACTORY_GREP" "$FACTORY_PINNED"' };
const PINNED_HERE = new RegExp(`^${ctx.id}-\\d{2}-[a-z0-9-]+\\.(spec\\.ts|test\\.mjs)$`);  // verify's name for a test this run pinned
// a criterion marked anything but live-safe: yes never runs on a deployment
const spec = (() => { try { return fs.readFileSync(at("spec.md"), "utf8"); } catch { return ""; } })();
const liveSafe = new Set([...spec.matchAll(/^- \*\*(SC-\d{3})\*\* \(([^)]*)\)/gm)].filter((m) => /\blive-safe: yes\b/.test(m[2])).map((m) => m[1]));
// the app whose path holds a file, deepest first, as verify has it
const appOf = (rel) => (recipe.apps || []).map((a) => [a, path.normalize(a.path || ".")]).filter(([, p]) => p === "." || rel.startsWith(p + path.sep))
  .sort(([, a], [, b]) => b.length - a.length)[0]?.[0];
async function runSmoke() {
  const ready = Object.values(deployments).filter((d) => d?.status === "success"), failed = Object.values(deployments).find((d) => d?.status === "failed");
  if (!hosted.length) return { state: "skipped", why: "no app is deployed through GitHub deployments" };
  if (!ready.length) return { state: "skipped", why: failed ? `the deployment of ${short} failed: ${failed.reason}` : deployments[hosted[0].name].reason };
  for (const d of ready) {
    const w = await loginWall(d.url, headers);
    d.probe = w.why;
    if (w.wall) return { state: "blocked", why: `login wall at ${d.url}: ${w.why}` };
  }
  const missing = [].concat(recipe.smoke?.test_user ?? []).map((n) => `WATCH_${n}`).filter((n) => !smokeEnv[n]);
  if (missing.length) return { state: "blocked", why: `no test user: ${missing.join(", ")} isn't in .factory/env.local` };
  const tests = [].concat(recipe.pinned ?? []).flatMap((d) => {
    const rel = path.normalize(String(d)).replace(/\/+$/, ""), abs = path.join(ctx.worktree, rel);
    return fs.existsSync(abs) ? fs.readdirSync(abs).filter((f) => PINNED_HERE.test(f)).sort().map((f) => path.join(rel, f)) : [];
  }).flatMap((rel) => {
    const ids = [...new Set([...fs.readFileSync(path.join(ctx.worktree, rel), "utf8").matchAll(/\[[a-z0-9-]+\] (SC-\d{3}):/g)].map((m) => m[1]))].filter((id) => liveSafe.has(id));
    const app = appOf(rel), d = app && deployments[app.name];
    return ids.length && d?.status === "success" ? [{ rel, app, url: d.url, ids }] : [];
  });
  if (!tests.length) return { state: "skipped", why: "no pinned test of a live-safe criterion on a deployed app" };
  fs.mkdirSync(at("logs"), { recursive: true });
  // ponytail: the timeout kills bash alone, as preview's does, so a browser it started can outlive it; give the smoke a
  // process group if one ever does.
  const results = tests.map(({ rel, app, url, ids }) => {
    const appDir = path.join(ctx.worktree, app.path || "."), log = at(`logs/smoke-${rel.replace(/[^\w.-]/g, "_")}.log`);
    const env = { ...smokeEnv, BASE_URL: new URL(url).origin, FACTORY_PINNED: path.relative(appDir, path.join(ctx.worktree, rel)),
      FACTORY_GREP: `\\[${ctx.id}\\] (${ids.join("|")}):`, ...(Object.keys(headers).length && { FACTORY_WATCH_HEADERS: JSON.stringify(headers) }) };
    const r = spawnSync("bash", ["-c", RUNNERS[Object.keys(RUNNERS).find((x) => rel.endsWith(x))]], { cwd: appDir, env, encoding: "utf8", maxBuffer: 1 << 28, timeout: 10 * 60_000 });
    const output = redact(`${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\npost-merge: ${r.error.message}\n` : ""}`);
    fs.writeFileSync(log, output);
    // an unsure run is no red: a false revert pauses auto for every run (#32)
    const status = r.status === 0 ? "pass" : r.error || r.status === null || r.status === 127 ? "infra" : output.includes(SIGN_IN) ? "sign-in failed" : "fail";
    return { test: rel, app: app.name, criteria: ids, status, log, ...(status === "fail" && { digest: digest(output, log) }) };
  });
  const by = (st) => results.filter((t) => t.status === st), red = by("fail");
  // ponytail: a file whose output carries the marker is all blocked, so a test in it failing after another's failed
  // sign-in reads blocked too; run each test alone if that ever hides a red.
  return red.length ? { state: "fail", why: `the smoke failed on ${red.map((t) => t.test).join(", ")}`, tests: results }
    : by("sign-in failed").length ? { state: "blocked", why: "sign-in failed", tests: results }
    : by("infra").length ? { state: "infra", why: `${by("infra").map((t) => t.test).join(", ")} never finished`, tests: results } : { state: "pass", tests: results };
}

let ci = null, smoke = null;
for (;;) {
  ci ??= readCi();
  if (ci?.state === "red") break;
  if (Object.values(deployments).some((d) => !d)) readDeployments();
  if (!smoke && Object.values(deployments).every(Boolean)) smoke = await runSmoke();
  if (smoke?.state === "fail" || (ci && smoke) || Date.now() >= end) break;
  pause(Math.max(0, Math.min(EVERY * 1000, end - Date.now())));
}
const ciRed = ci?.state === "red";
ci ??= { state: "infra", why: ciRefused ? `GitHub refused the workflow runs at ${short}: ${ciRefused}`
  : runs.length ? `CI at ${short} unfinished after ${waited()}: ${runs.filter((w) => w.status !== "completed").map((w) => `${w.name} ${w.status}`).join(", ")}`
  : `no workflow run appeared at ${short} in ${waited()}` };
for (const a of hosted) deployments[a.name] ??= { status: "none", reason: ciRed ? "not read: CI is red"
  : `no deployment of ${short} reached success in ${waited()}${deployRefused ? ` (GitHub: ${deployRefused})` : ""}` };
smoke ??= ciRed ? { state: "skipped", why: "CI is red" } : await runSmoke();
const red = ciRed || smoke.state === "fail", failing = (smoke.tests || []).filter((t) => t.status === "fail");

// The revert of the merge on the target's tip, from a worktree of its own, pushed as revert/<run>-<sha>, then its PR,
// opened ready for the human to merge or close. The project's hooks expect dependencies a bare worktree hasn't got.
// A merge commit's revert takes -m 1, a squash's is one plain commit, as the configured method merged it.
// ponytail: a rebase merge of several commits reverts only its last; revert the PR's whole range if a project merges so.
let mainline = (readJson(path.join(ctx.MAIN, ".factory", "config.json"), {}).merge_method || "merge") === "merge";
function revert() {
  const branch = `revert/${ctx.id}-${short}`, wt = fs.mkdtempSync(path.join(worktreesDir(ctx.MAIN), ".revert-"));
  const g = (...a) => git(wt, "-c", "core.hooksPath=/dev/null", ...a);
  try {
    try {
      git(ctx.MAIN, "worktree", "add", "-q", "--detach", wt, liveBase(ctx.worktree, target));
      mainline = git(wt, "rev-list", "--parents", "-n", "1", sha).split(" ").length > 2;
      g("revert", "--no-edit", ...(mainline ? ["-m", "1"] : []), sha);
      g("push", "-q", "origin", `HEAD:refs/heads/${branch}`);
    } catch (e) { return { failed: `git: ${gitError(e)}` }; }
  } finally { try { git(ctx.MAIN, "worktree", "remove", "--force", wt); } catch {} }
  const what = ciRed ? ci.why : `${smoke.why}, at ${failing.map((t) => deployments[t.app].url).join(", ")}`;
  const body = `The factory's watch after it merged #${pr.number} found it red on \`${target}\`: ${what}.\n\n`
    + failing.map((t) => `\`${t.test}\`:\n\n\`\`\`\n${t.digest}\n\`\`\`\n\n`).join("")
    + `This is a \`git revert\` of \`${short}\`. The factory never merges it: merge it to undo #${pr.number}, or close it when the red is a flake `
    + `or already fixed forward. While it's open, \`merge: auto\` acts as trial. Run \`${ctx.id}\`.`;
  const made = ghApi("-X", "POST", `repos/${repo}/pulls`, "-f", `title=Revert PR #${pr.number}: ${ciRed ? `CI is red at ${short}` : "the smoke failed"}`,
    "-f", `head=${branch}`, "-f", `base=${target}`, "-f", `body=${body}`);
  if (!made.ok) return { branch, failed: `GitHub refused the PR: ${made.message}` };
  const labels = ghApi("-X", "POST", `repos/${repo}/issues/${made.json.number}/labels`, "-f", "labels[]=factory", "-f", "labels[]=needs-human");
  return { branch, number: made.json.number, url: made.json.html_url, ...(!labels.ok && { unlabelled: labels.message }) };
}
const revertPr = red ? revert() : null;

// one status for the deployments, or each app's when they differ
const statuses = new Set(Object.values(deployments).map((d) => d.status));
const deployWord = !hosted.length ? "none" : statuses.size === 1 ? [...statuses][0] : Object.entries(deployments).map(([n, d]) => `${n} ${d.status}`).join(", ");
const smokeWord = ["pass", "fail"].includes(smoke.state) ? smoke.state : `${smoke.state} (${smoke.why})`;
const line = `post-merge: ${ctx.id} ${short} on ${target}: ci=${ci.state} deploy=${deployWord} smoke=${smokeWord} revert=${!revertPr ? "none" : revertPr.number ? `#${revertPr.number}` : "failed"}`;
fs.writeFileSync(at("post-merge.json"), JSON.stringify({ run: ctx.id, sha, target, pr: pr.number, ci, deploy: deployments, smoke, revert: revertPr, at: new Date().toISOString() }, null, 2) + "\n");
fs.appendFileSync(at("run.log"), `- ${new Date().toISOString()} ${line}\n`);
console.log([`POST-MERGE ${line.slice("post-merge: ".length)}`, ...failing.map((t) => `--- ${t.test} fail\n${t.digest}`), `post-merge.json: ${at("post-merge.json")}`].join("\n"));
if (!red) process.exit(0);

// Red: the human's, through the revert PR.
const file = at("attention-post-merge.md");
fs.writeFileSync(file, attentionItem({ id: ctx.id, stage: "post-merge", evidence: [at("post-merge.json"), ...failing.map((t) => t.log)],
  headline: revertPr.number ? `PR #${pr.number}'s merge is red on ${target}: revert PR #${revertPr.number} is open` : `PR #${pr.number}'s merge is red on ${target}, and its revert couldn't be opened`,
  happened: `The watch read ${ciRed ? ci.why : `${smoke.why}, against the deployment of \`${short}\``}. `
    + (revertPr.number ? `It opened revert PR #${revertPr.number}, a \`git revert\` of \`${short}\` on \`${revertPr.branch}\`, labelled factory and needs-human${revertPr.unlabelled ? ` (the labels failed: ${revertPr.unlabelled}; add them by hand)` : ""}. The factory never merges it, and while it's open \`merge: auto\` acts as trial.`
      : `Opening its revert failed: ${revertPr.failed}.`),
  recommendation: revertPr.number ? `Read the red, then merge revert PR #${revertPr.number} to undo PR #${pr.number}, or close it when the red is a flake or already fixed forward.`
    : `Revert PR #${pr.number}'s merge on ${target} yourself, or fix it forward.`,
  options: revertPr.number ? [[revertPr.url, `the revert PR: merging it yourself undoes PR #${pr.number}`],
    [`gh api -X PATCH repos/${repo}/pulls/${revertPr.number} -f state=closed`, "closes it, when the red is a flake or already fixed forward; auto merges again once no revert PR is open"]]
    : [[`git revert ${mainline ? "-m 1 " : ""}${sha}`, `on ${target}, reverts the merge by hand`]] }));
const r = spawnSync(process.execPath, [fileURLToPath(new URL("run-state.mjs", import.meta.url)), "set", "stage", "needs-human", "--run", ctx.id], { encoding: "utf8" });
if (r.status) die(`run-state set stage needs-human failed: ${r.stderr}`);
console.log(`needs-human: ${file}`);
process.exit(1);
