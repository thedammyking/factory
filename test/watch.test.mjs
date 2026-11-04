// watch.test.mjs — the watch after the factory's own merge: post-merge spawned as a process on a run whose PR #7 the
// factory merged on o/r (a GitHub URL rewritten to a local bare remote, where a clone made the merge as GitHub would), with
// a fake `gh` answering CI and the deployment from fixtures, a local node:http server standing in for the deployment and
// its login wall, and spies on PATH recording the environment of every gh and git call. Then setup's section C probe.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { project, script, startRun, fakeClis, githubOrigin, sh, write } from "./harness.mjs";

const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const SECRET = "bypass-secret-0123456789", STAGING = "staging-password-2468", LOCAL = "local-password-1357";
const ENV_LOCAL = `E2E_EMAIL=local@example.test\nE2E_PASSWORD=${LOCAL}\nVERCEL_AUTOMATION_BYPASS_SECRET=${SECRET}\n`
  + `WATCH_E2E_EMAIL=staging@example.test\nWATCH_E2E_PASSWORD=${STAGING}\n`;
const SMOKE = { headers: { "x-vercel-protection-bypass": "{env:VERCEL_AUTOMATION_BYPASS_SECRET}" }, test_user: ["E2E_EMAIL", "E2E_PASSWORD"] };
const RECIPE = (smoke = SMOKE) => ({ apps: [{ name: "web", type: "web", path: ".", checks: { test: "true" } }], pinned: ["e2e"],
  preview: { web: { mode: "github-deployment", environment: "Preview" } }, ...(smoke && { smoke }) });
const SPEC = "# Signup\n\n## Success criteria\n- **SC-001** (profile: default, live-safe: yes): `/`, the page shows \"Welcome\".\n"
  + "- **SC-002** (profile: default, live-safe: no): Signing up makes an account.\n";

// The deployment, a process of its own since the scripts are spawned synchronously: a 401, a 403, a redirect off its host
// (off) or on it (on) unless a request carries the bypass header, as mode.json's wall says; past it, / answers "Welcome"
// (a 500 when broken) and /session signs the test user in (refuses when signin is false: a failed sign-in). Each request
// it gets goes to seen.jsonl, with whether it carried the header. It's killed after the test, pass or fail.
const SERVER = `import http from "node:http";
import fs from "node:fs";
const dir = process.argv[2], at = (f) => dir + "/" + f;
const WALLS = { 401: [401], 403: [403], off: [307, { location: "https://vercel.com/sso-api?url=x" }], on: [302, { location: "/login" }] };
http.createServer((q, s) => {
  const d = JSON.parse(fs.readFileSync(at("mode.json"), "utf8")), passed = q.headers["x-vercel-protection-bypass"] === ${JSON.stringify(SECRET)};
  fs.appendFileSync(at("seen.jsonl"), JSON.stringify({ path: q.url, header: passed }) + "\\n");
  if (!passed && d.wall in WALLS) { s.writeHead(...WALLS[d.wall]); return s.end("Authentication Required"); }
  if (q.url === "/session") { s.statusCode = d.signin ? 200 : 401; return s.end(); }
  s.statusCode = d.broken ? 500 : 200;
  s.end(d.broken ? "Internal Server Error" : "Welcome");
}).listen(0, "127.0.0.1", function () { fs.writeFileSync(at("port"), String(this.address().port)); });
`;
function deployment(t) {
  const dir = tmp("factory-deployment-"), at = (f) => path.join(dir, f);
  fs.writeFileSync(at("server.mjs"), SERVER);
  const set = (change) => fs.writeFileSync(at("mode.json"), JSON.stringify({ ...JSON.parse(fs.readFileSync(at("mode.json"), "utf8")), ...change }));
  fs.writeFileSync(at("mode.json"), JSON.stringify({ wall: "401", broken: false, signin: true }));
  const child = spawn(process.execPath, [at("server.mjs"), dir], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  for (let n = 0; !fs.existsSync(at("port")) && n < 250; n++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  const url = `http://127.0.0.1:${fs.readFileSync(at("port"), "utf8")}/`;
  const seen = () => fs.existsSync(at("seen.jsonl")) ? fs.readFileSync(at("seen.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  return { set, seen, url: () => url };
}

// A pinned test as qa writes one: it records its environment, prints what a careless test might (the header and the
// password), spreads FACTORY_WATCH_HEADERS into its requests, signs in through a step whose failure carries the marker,
// then asserts the page. With a file `kill` in the dump dir it kills its runner instead, a run that never finished.
// SC-002 isn't live-safe, and leaves a file wherever it runs.
const PINNED = (id, dump) => `// Pinned by the factory from .factory/history/${id}/spec.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const headers = JSON.parse(process.env.FACTORY_WATCH_HEADERS ?? "{}");
const signIn = async () => {
  const r = await fetch(\`\${process.env.BASE_URL}/session\`, { headers: { ...headers } });
  if (!r.ok) throw new Error(\`FACTORY_SIGN_IN_FAILED: /session answered \${r.status}\`);
};
test("[${id}] SC-001: \`/\`, the page shows \\"Welcome\\".", async () => {
  fs.appendFileSync(${JSON.stringify(path.join(dump, "smoke.jsonl"))}, JSON.stringify({ ...process.env }) + "\\n");
  if (process.env.FACTORY_WATCH_HEADERS) console.log("careless:", JSON.stringify(headers), process.env.E2E_PASSWORD);
  if (fs.existsSync(${JSON.stringify(path.join(dump, "kill"))})) { process.kill(process.ppid, "SIGKILL"); process.exit(1); }
  await signIn();
  const r = await fetch(\`\${process.env.BASE_URL}/\`, { headers: { ...headers } });
  assert.equal(await r.text(), "Welcome");
});
test("[${id}] SC-002: Signing up makes an account.", () => fs.writeFileSync(${JSON.stringify(path.join(dump, "sc-002-ran"))}, ""));
`;

// Spies first on PATH: each gh and git call appends its environment to <name>.env.jsonl, then runs the fake gh or the real
// git. The gh spy refuses the first `refuse` reads of CI itself, as GitHub refusing a call does.
function spies(fakeBin, refuse = 0) {
  const bin = tmp("factory-spies-"), real = { gh: path.join(fakeBin, "gh"), git: sh(os.tmpdir(), "which", ["git"]) };
  for (const [name, target] of Object.entries(real)) fs.writeFileSync(path.join(bin, name), `#!${process.execPath}
const fs = require("node:fs"), { spawnSync } = require("node:child_process");
fs.appendFileSync(${JSON.stringify(path.join(bin, `${name}.env.jsonl`))}, JSON.stringify(process.env) + "\\n");
const refused = ${JSON.stringify(path.join(bin, "refused"))}, n = fs.existsSync(refused) ? fs.readFileSync(refused, "utf8").length : 0;
if (${JSON.stringify(name)} === "gh" && process.argv.slice(2).join(" ").includes("actions/runs") && n < ${refuse}) {
  fs.appendFileSync(refused, "x"); process.stdout.write('{"message":"Server Error"}'); process.exit(1);
}
process.exit(spawnSync(${JSON.stringify(target)}, process.argv.slice(2), { stdio: "inherit" }).status ?? 1);
`, { mode: 0o755 });
  const envs = (name) => { const f = path.join(bin, `${name}.env.jsonl`); return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []; };
  return { bin, envs };
}

// A run past the factory's own merge of PR #7 into main: the run branch holds a product change and the pinned test,
// a clone of the remote merged it --no-ff and pushed, and decision.json records that merge. watch(answers, args) runs
// post-merge from the main checkout against a fake gh answering CI at the merged SHA (`ci`, poll by poll), its deployments
// and their statuses (`statuses`, poll by poll), and the revert PR and its labels.
function merged(t, { recipe = RECIPE(), envLocal = ENV_LOCAL } = {}) {
  const p = project({ recipe, config: { merge: "auto", merge_method: "merge" } }), bare = githubOrigin(p);
  const s = startRun(p), dump = tmp("factory-dump-"), d = deployment(t);
  const rs = (...args) => { const r = script("run-state.mjs", p.dir, [...args, "--run", s.id], { env: ENV }); assert.equal(r.status, 0, r.stderr + r.stdout); return r; };
  rs("set", "route", "build"); rs("set", "branch", "feature/signup"); rs("set", "target_branch", "main");
  s.commit({ "src/signup.js": "export const signup = () => 'Welcome';\n", [`e2e/${s.id}-01-signup.test.mjs`]: PINNED(s.id, dump) }, "Add the signup form");
  const head = s.git("rev-parse", "HEAD"), before = p.git("rev-parse", "main");
  s.git("push", "-q", "origin", "HEAD:refs/heads/feature/signup");
  const clone = tmp("factory-github-");
  sh(clone, "git", ["clone", "-q", bare, "."]);
  for (const kv of [["user.name", "GitHub"], ["user.email", "noreply@github.com"]]) sh(clone, "git", ["config", ...kv]);
  sh(clone, "git", ["merge", "-q", "--no-ff", "-m", "Merge pull request #7 from o/feature/signup", "origin/feature/signup"]);
  sh(clone, "git", ["push", "-q", "origin", "main"]);
  const sha = sh(clone, "git", ["rev-parse", "HEAD"]);
  write(p.dir, { ".factory/env.local": envLocal });
  write(s.run_dir, {
    "spec.md": SPEC,
    "pr.json": JSON.stringify({ repo: "o/r", number: 7, url: "https://github.com/o/r/pull/7", head: "feature/signup", base: "main", labels: ["factory", "factory-merge"], comments: [] }),
    "decision.json": JSON.stringify({ run: s.id, head, mode: "auto", decision: "merge", reasons: [], facts: [], merged: sha }),
  });
  const canned = tmp("factory-canned-");
  let n = 0;
  const file = (body) => { const f = path.join(canned, `${n++}`); fs.writeFileSync(f, typeof body === "string" ? body : JSON.stringify(body)); return f; };
  const wf = (conclusion, status = "completed") => ({ id: 31, name: "CI", event: "push", status, conclusion: status === "completed" ? conclusion : null, html_url: "https://github.com/o/r/actions/runs/31" });
  let gh, spy;
  const watch = ({ ci = [[wf("success")]], statuses = [[{ state: "success", environment_url: d.url() }]], deployments = [{ id: 51, sha, environment: "Preview" }], refuse = 0 } = {}, args = ["--window", "0"]) => {
    gh = fakeClis({ gh: [
      { match: new RegExp(`^api repos/o/r/actions/runs\\?head_sha=${sha}&per_page=100$`), file: ci.map((runs) => file({ total_count: runs.length, workflow_runs: runs })) },
      { match: new RegExp(`^api repos/o/r/deployments\\?sha=${sha}&per_page=100$`), file: file(deployments) },
      { match: /^api repos\/o\/r\/deployments\/51\/statuses\?per_page=1$/, file: statuses.map((list) => file(list)) },
      { match: /^api -X POST repos\/o\/r\/pulls /, file: file({ number: 9, html_url: "https://github.com/o/r/pull/9" }) },
      { match: /^api -X POST repos\/o\/r\/issues\/9\/labels /, file: file([{ name: "factory" }, { name: "needs-human" }]) },
    ] });
    spy = spies(gh.bin, refuse);
    return script("post-merge.mjs", p.dir, ["--every", "0", ...args, "--run", s.id], { env: { ...ENV, PATH: [spy.bin, gh.bin, process.env.PATH].join(path.delimiter) } });
  };
  const calls = () => gh.calls("gh"), posts = () => calls().filter((c) => c[1] === "-X" && c[2] === "POST");
  const smokes = () => { const f = path.join(dump, "smoke.jsonl"); return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []; };
  const runLog = () => fs.readFileSync(path.join(s.run_dir, "run.log"), "utf8");
  const state = () => JSON.parse(fs.readFileSync(path.join(s.run_dir, "state.json"), "utf8"));
  return { p, s, bare, d, dump, sha, head, before, rs, watch, wf, calls, posts, smokes, runLog, state, spies: () => spy };
}
const ENV = { ...process.env, CLAUDE_CONFIG_DIR: tmp("factory-claude-") };
delete ENV.CLAUDE_CODE_SESSION_ID;
const lines = (text) => text.split("\n").filter((l) => / post-merge: /.test(l));
const secretFree = (text, why) => { for (const v of [SECRET, STAGING]) assert.ok(!text.includes(v), `${why} holds a secret`); };
// The headers and the WATCH_ values reach the smoke command alone: no gh or git call post-merge made, itself or through
// run-state, had them.
function smokeAlone(w) {
  for (const name of ["gh", "git"]) {
    const envs = w.spies().envs(name);
    assert.ok(envs.length > 0, `${name} was called`);
    for (const e of envs) {
      assert.equal(e.FACTORY_WATCH_HEADERS, undefined, `${name}'s environment`);
      secretFree(JSON.stringify(e), `${name}'s environment`);
    }
  }
}

test("green: CI at the merged SHA, the deployment, a probe past the wall with smoke.headers, then the live-safe pinned tests against it as the target's test user; one post-merge line", (t) => {
  const w = merged(t), r = w.watch();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, new RegExp(`^POST-MERGE ${w.s.id} ${w.sha.slice(0, 7)} on main: ci=green deploy=success smoke=pass revert=none$`, "m"));
  assert.deepEqual(w.d.seen(), [{ path: "/", header: true }, { path: "/session", header: true }, { path: "/", header: true }], "one probe GET, then the smoke's requests, all past the wall");
  const [env] = w.smokes();
  assert.equal(w.smokes().length, 1, "SC-001's test ran once");
  assert.deepEqual(JSON.parse(env.FACTORY_WATCH_HEADERS), { "x-vercel-protection-bypass": SECRET });
  assert.deepEqual([env.E2E_EMAIL, env.E2E_PASSWORD, env.BASE_URL], ["staging@example.test", STAGING, new URL(w.d.url()).origin], "WATCH_X is X, on the smoke command");
  assert.ok(!fs.existsSync(path.join(w.dump, "sc-002-ran")), "a criterion that isn't live-safe never runs on the deployment");
  assert.deepEqual(w.posts(), [], "nothing opened");
  assert.equal(w.state().stage, "start", "the run's stage is the orchestrator's to end");
  assert.equal(lines(w.runLog()).length, 1);
  const pm = JSON.parse(fs.readFileSync(path.join(w.s.run_dir, "post-merge.json"), "utf8"));
  assert.deepEqual([pm.sha, pm.target, pm.ci.state, pm.deploy.web.status, pm.deploy.web.url, pm.smoke.state, pm.revert], [w.sha, "main", "green", "success", w.d.url(), "pass", null]);
  for (const out of [r.stdout, r.stderr, fs.readFileSync(path.join(w.s.run_dir, "post-merge.json"), "utf8"), w.runLog()]) secretFree(out, "post-merge's output");

  // and no verify of the same pinned test
  smokeAlone(w);
  const v = script("verify.mjs", w.p.dir, ["--pinned", path.join(w.s.worktree, `e2e/${w.s.id}-01-signup.test.mjs`)], { env: ENV });
  const local = w.smokes()[1];
  assert.ok(local, v.stdout + v.stderr);
  assert.equal(local.FACTORY_WATCH_HEADERS, undefined, "verify's pinned run gets no headers");
  assert.deepEqual([local.E2E_EMAIL, local.E2E_PASSWORD], ["local@example.test", LOCAL], "and the local test user");

  w.rs("set", "stage", "delivered");
  const snap = script("run-state.mjs", w.p.dir, ["snapshot", "--run", w.s.id], { env: ENV });
  assert.equal(snap.status, 0, snap.stdout + snap.stderr);
  const logMd = w.p.git("show", "main:.factory/log.md");
  assert.equal(lines(logMd).length, 1, "one post-merge: line in log.md");
  assert.match(lines(logMd)[0], /^- \S+ post-merge: \S+ [0-9a-f]{7} on main: ci=green deploy=success smoke=pass revert=none$/);
});

// The revert PR on o/r: its branch on the remote, a git revert -m 1 of the merge that leaves main's tree as it was before.
function reverted(w, why) {
  const branch = `revert/${w.s.id}-${w.sha.slice(0, 7)}`;
  assert.equal(sh(w.bare, "git", ["rev-parse", `${branch}^`]), w.sha, "the revert sits on the merge");
  assert.equal(sh(w.bare, "git", ["diff", "--stat", w.before, branch]), "", "and undoes it, back to main's tree before the merge");
  assert.match(sh(w.bare, "git", ["log", "-1", "--format=%B", branch]), new RegExp(`^Revert "Merge pull request #7[\\s\\S]*This reverts commit ${w.sha}, reversing\\nchanges made to ${w.before}`));
  const [open, labels, ...more] = w.posts();
  assert.deepEqual(more, [], "one PR and its labels, nothing else");
  const field = (c, k) => c[c.indexOf(c.find((a) => a.startsWith(`${k}=`)))].slice(k.length + 1);
  assert.equal(open[3], "repos/o/r/pulls");
  assert.deepEqual([field(open, "head"), field(open, "base")], [branch, "main"]);
  assert.match(field(open, "title"), new RegExp(`^Revert PR #7: ${why}`));
  assert.match(field(open, "body"), /never merges it/);
  assert.deepEqual(labels.slice(3), ["repos/o/r/issues/9/labels", "-f", "labels[]=factory", "-f", "labels[]=needs-human"]);
  assert.ok(w.calls().every((c) => !c.join(" ").includes("/merge")), "the factory never merges it");
  assert.equal(w.state().stage, "needs-human");
  const item = fs.readFileSync(path.join(w.s.run_dir, "attention-post-merge.md"), "utf8");
  assert.match(item, /^# PR #7's merge is red on main: revert PR #9 is open$/m);
  return { open, item, field };
}

test("red smoke: a pinned test failing after sign-in opens a revert PR on revert/<run>-<sha>, labelled factory and needs-human, and the run ends needs-human; no secret reaches a file, the PR or the log", (t) => {
  const w = merged(t);
  w.d.set({ broken: true });
  const r = w.watch();
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.match(r.stdout, new RegExp(`^POST-MERGE ${w.s.id} ${w.sha.slice(0, 7)} on main: ci=green deploy=success smoke=fail revert=#9$`, "m"));
  assert.match(r.stdout, /^needs-human: .*attention-post-merge\.md$/m);
  const { open, item, field } = reverted(w, "the smoke failed");
  const logs = fs.readdirSync(path.join(w.s.run_dir, "logs")).map((f) => fs.readFileSync(path.join(w.s.run_dir, "logs", f), "utf8"));
  assert.match(logs.join("\n"), /careless: \{"x-vercel-protection-bypass":"\{env:[A-Z_]+\}"\} \{env:[A-Z_]*E2E_PASSWORD\}/, "the smoke's output names variables, never their values");
  assert.match(field(open, "body"), /Expected values to be strictly equal/, "the PR carries the red test's digest");
  for (const text of [r.stdout, r.stderr, item, field(open, "body"), w.runLog(), ...logs]) secretFree(text, "a run file");
  smokeAlone(w);  // the revert's git calls and run-state's too
  const snap = script("run-state.mjs", w.p.dir, ["snapshot", "--run", w.s.id], { env: ENV });
  assert.equal(snap.status, 0, `the snapshot finds no credential: ${snap.stdout}${snap.stderr}`);
  assert.deepEqual(lines(w.p.git("show", "main:.factory/log.md")).map((l) => l.replace(/^- \S+ /, "")), [`post-merge: ${w.s.id} ${w.sha.slice(0, 7)} on main: ci=green deploy=success smoke=fail revert=#9`]);
});

test("red CI: a workflow run failing at the merged SHA opens the revert PR at once, with no probe or smoke", (t) => {
  const w = merged(t), r = w.watch({ ci: [[w.wf("failure")]] });
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.match(r.stdout, / on main: ci=red deploy=none smoke=skipped \(CI is red\) revert=#9$/m);
  reverted(w, "CI is red at");
  assert.deepEqual(w.d.seen(), [], "nothing reached the deployment");
  assert.ok(!w.calls().some((c) => c[1].includes("deployments")), "nor was it read");
});

test("blocked (login wall): a 401, a 403, a redirect off the host or no answer at the probe opens nothing, runs no smoke and changes nothing else", (t) => {
  for (const [wall, why] of [["401", "401"], ["403", "403"], ["off", "307 to vercel.com"], ["gone", "no answer"]]) {
    const w = merged(t, { recipe: RECIPE({ test_user: ["E2E_EMAIL", "E2E_PASSWORD"] }) });  // no smoke.headers
    w.d.set({ wall });
    const url = wall === "gone" ? "http://127.0.0.1:9/" : w.d.url();
    const r = w.watch({ statuses: [[{ state: "success", environment_url: url }]] });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, new RegExp(`ci=green deploy=success smoke=blocked \\(login wall at ${url.replaceAll(".", "\\.")}: ${why}[^)]*\\) revert=none$`, "m"), wall);
    assert.deepEqual(w.posts(), [], `${wall}: nothing opened`);
    assert.deepEqual(w.smokes(), [], `${wall}: no smoke`);
    assert.equal(w.state().stage, "start", `${wall}: the run is untouched`);
    assert.ok(!fs.existsSync(path.join(w.s.run_dir, "attention-post-merge.md")));
    if (wall !== "gone") assert.deepEqual(w.d.seen(), [{ path: "/", header: false }], "one GET, with no headers to send");
  }
});

test("blocked (no test user): a test user the recipe declares with no WATCH_ value in env.local opens nothing and runs no smoke", (t) => {
  const w = merged(t, { envLocal: ENV_LOCAL.replace(/^WATCH_E2E_PASSWORD=.*\n/m, "") }), r = w.watch();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /smoke=blocked \(no test user: WATCH_E2E_PASSWORD isn't in \.factory\/env\.local\) revert=none$/m);
  assert.deepEqual([w.posts(), w.smokes(), w.state().stage], [[], [], "start"]);
});

test("blocked (sign-in failed): a pinned test failing at the shared sign-in step, its marker in the output, opens nothing; a test user's short password is still kept out of its log", (t) => {
  const w = merged(t, { envLocal: ENV_LOCAL.replace(/^WATCH_E2E_PASSWORD=.*$/m, "WATCH_E2E_PASSWORD=pw42") });
  w.d.set({ signin: false });
  const r = w.watch();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /smoke=blocked \(sign-in failed\) revert=none$/m);
  assert.equal(w.smokes().length, 1, "the smoke ran");
  assert.deepEqual([w.posts(), w.state().stage], [[], "start"]);
  const log = fs.readFileSync(JSON.parse(fs.readFileSync(path.join(w.s.run_dir, "post-merge.json"), "utf8")).smoke.tests[0].log, "utf8");
  assert.match(log, /careless: .* \{env:[A-Z_]*E2E_PASSWORD\}/);
  assert.ok(!log.includes("pw42"));
});

test("a pinned test that never finished, its runner killed, is infra, not red: it opens nothing", (t) => {
  const w = merged(t);
  fs.writeFileSync(path.join(w.dump, "kill"), "");
  const r = w.watch();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, new RegExp(`smoke=infra \\(e2e/${w.s.id}-01-signup\\.test\\.mjs never finished\\) revert=none$`, "m"));
  assert.deepEqual([w.posts(), w.state().stage], [[], "start"]);
});

test("the window: CI and the deployment are polled every --every seconds until they settle, at most --window seconds; what never settles is infra and none, which open nothing", (t) => {
  const w = merged(t);
  let r = w.watch({ ci: [[w.wf(null, "in_progress")], [w.wf(null, "in_progress")], [w.wf("success")]], statuses: [[{ state: "pending" }], [{ state: "success", environment_url: w.d.url() }]] }, ["--window", "30"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /ci=green deploy=success smoke=pass revert=none$/m);
  assert.equal(w.calls().filter((c) => c[1].includes("actions/runs")).length, 3, "CI read until it finished, then no more");
  assert.equal(w.calls().filter((c) => c[1].includes("/statuses")).length, 2);

  r = w.watch({ ci: [[w.wf(null, "in_progress")]], statuses: [[{ state: "pending" }]] }, ["--window", "0"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /ci=infra deploy=none smoke=skipped \(no deployment of [0-9a-f]{7} reached success in \d+ s\) revert=none$/m);
  assert.deepEqual([w.posts(), w.state().stage], [[], "start"]);
  const pm = JSON.parse(fs.readFileSync(path.join(w.s.run_dir, "post-merge.json"), "utf8"));
  assert.match(pm.ci.why, /^CI at [0-9a-f]{7} unfinished after \d+ s: CI in_progress$/);

  // GitHub refusing a read of CI settles nothing: the next poll reads it, and a red there opens the revert
  r = w.watch({ ci: [[w.wf("failure")]], refuse: 1 }, ["--window", "30"]);
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.match(r.stdout, / on main: ci=red deploy=success smoke=pass revert=#9$/m, "the smoke passed meanwhile, and CI's red is red still");
  assert.equal(w.calls().filter((c) => c[1].includes("actions/runs")).length, 1, "read again after the refusal");
});

test("the watch runs only after the factory's own merge: without decision.json's merged SHA it reads nothing", (t) => {
  const w = merged(t);
  write(w.s.run_dir, { "decision.json": JSON.stringify({ run: w.s.id, mode: "trial", decision: "merge" }) });
  const r = w.watch();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /only after the factory's own merge/);
  assert.deepEqual(w.calls(), []);
});

// Setup's section C on a trunk project whose main tip has one deployment, at the stand-in: detect, then run(args,
// statuses) with a fake gh answering the tip's commit, its deployments and their latest status.
function setupProject(t) {
  const p = project();
  p.git("rm", "-rq", ".factory");
  fs.rmSync(path.join(p.dir, ".factory"), { recursive: true, force: true });
  write(p.dir, { "package.json": JSON.stringify({ name: "shop", scripts: { test: "node -e 0" } }) });
  p.git("add", "-A"); p.git("commit", "-qm", "shop");
  p.git("remote", "add", "origin", "https://github.com/acme/shop.git");
  const d = deployment(t), canned = tmp("factory-canned-"), TIP = "f00d".padEnd(40, "0");
  let n = 0;
  const file = (body) => { const f = path.join(canned, `${n++}`); fs.writeFileSync(f, typeof body === "string" ? body : JSON.stringify(body)); return f; };
  const run = (args, statuses = [{ state: "success", environment_url: d.url() }]) => {
    const gh = fakeClis({ gh: [
      { match: /^auth status/, file: file("") },
      { match: /^api repos\/acme\/shop$/, file: file({ default_branch: "main", allow_merge_commit: true, allow_squash_merge: true }) },
      { match: /^api repos\/acme\/shop\/commits\/main$/, file: file({ sha: TIP }) },
      { match: new RegExp(`^api repos/acme/shop/deployments\\?sha=${TIP}&per_page=100$`), file: file([{ id: 61, sha: TIP, environment: "Production" }]) },
      { match: /^api repos\/acme\/shop\/deployments\/61\/statuses\?per_page=1$/, file: file(statuses) },
      { match: /^api repos\/acme\/shop\/deployments/, file: file([]) },
    ] });
    return script("setup-factory.mjs", p.dir, args, { env: gh.env });
  };
  const detect = run(["detect"]);
  assert.equal(detect.status, 0, detect.stderr);
  return { p, d, run, url: d.url() };
}

test("setup's probe GETs the latest deployment of the branch auto merges into once: a wall exits 1 naming the status and a redirect's host; with the header set in env.local, probed again, it passes, the value never shown", (t) => {
  const p = setupProject(t);
  let r = p.run(["probe"]);
  assert.equal([r.status, r.stdout].join(" "), `1 wall     ${p.url}  401\n`, r.stderr);
  p.d.set({ wall: "off" });
  assert.equal(p.run(["probe"]).stdout, `wall     ${p.url}  307 to vercel.com\n`, "a redirect to vercel.com: setup recommends Vercel's bypass");
  p.d.set({ wall: "on" });
  r = p.run(["probe"]);
  assert.equal([r.status, r.stdout].join(" "), `0 no wall  ${p.url}  302 to ${new URL(p.url).host}\n`, "a redirect on the deployment's own host is the app's");

  p.d.set({ wall: "401" });
  write(p.p.dir, { ".factory/env.local": `VERCEL_AUTOMATION_BYPASS_SECRET=${SECRET}\n` });
  assert.equal(p.run(["set", "smoke.headers", JSON.stringify(SMOKE.headers)]).status, 0);
  assert.equal(p.run(["set", "smoke.test_user", JSON.stringify(SMOKE.test_user)]).status, 0);
  r = p.run(["probe"]);
  assert.equal([r.status, r.stdout].join(" "), `0 no wall  ${p.url}  200, with x-vercel-protection-bypass\n`);
  secretFree(r.stdout + r.stderr, "the probe's output");
  assert.deepEqual(p.d.seen().map((s) => s.header), [false, false, false, true], "one GET a probe, the header sent once it's set");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(p.p.dir, ".git/factory-setup.json"), "utf8")).recipe.smoke, SMOKE, "the recipe names the header's variable and the test user's, never a value");

  r = p.run(["probe"], [{ state: "pending" }]);
  assert.equal([r.status, r.stdout].join(" "), "0 no wall: no ready deployment of main at f00d000\n", "nothing deployed: no question");
});
