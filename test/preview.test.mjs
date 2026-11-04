// preview.test.mjs — preview.mjs spawned as a process on a run whose PR is open on o/r, a throwaway project whose origin
// is a local bare remote (a GitHub URL rewritten to it), with a fake `gh` answering REST calls from fixtures and fake
// `open` and `xdg-open`, so no test reaches GitHub or a browser: preview.json in each mode, and `try` on the preview
// or on the apps started locally, never both.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { project, script, startRun, fakeClis, githubOrigin, write, STUB_SERVER } from "./harness.mjs";

// run-state measures spend from transcripts under CLAUDE_CONFIG_DIR, so no test reads the real ~/.claude.
const ENV = { ...process.env, CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "factory-claude-")) };
delete ENV.CLAUDE_CODE_SESSION_ID;

const APPS = [
  { name: "web", type: "web", path: "web", dev: "node ../server.mjs {port:web}", health: "http://localhost:{port:web}/", checks: { test: "true" } },
  { name: "api", type: "backend", path: "api", dev: "node ../server.mjs {port:api}", health: "http://localhost:{port:api}/", checks: { test: "true" } },
];
const DEPLOYED = { web: { mode: "github-deployment", environment: "Preview" }, api: { mode: "github-deployment", environment: "Preview – api" } };
const SPEC = `# Signup

## Goal
A visitor can make an account from the signup page.

## Success criteria
- **SC-001** (profile: default, live-safe: yes): \`/signup\`, submit a new email and a password, the page shows "Welcome".
- **SC-002** (profile: default, live-safe: no): The account exists afterwards.
`;

// A run on the feature/signup branch whose PR #7 is open on o/r, the run's change in `changes` (web/ by default), and
// pr.md rendered from its spec. gh answers from files in a fixtures dir that reply(name, value) writes: `pr` for pulls/7,
// `deployments-<app>` for the app's environment at the head, `statuses-<app>` for deployment 100 plus the app's index,
// and `statuses` for any other. After the test, every app it started goes, by ALIVE.
function run(t, { preview = DEPLOYED, apps = APPS, changes = { "web/page.js": "export default 'Welcome';\n" }, title } = {}) {
  const p = project({ recipe: { apps, preview } }), bare = githubOrigin(p);
  const s = startRun(p, { "server.mjs": STUB_SERVER, "web/.keep": "", "api/.keep": "" });
  p.git("push", "-q", "origin", "main");
  const alive = path.join(p.dir, ".alive");
  fs.writeFileSync(alive, "");
  fs.writeFileSync(path.join(p.dir, ".factory/env.local"), `ALIVE=${alive}\n`);
  t.after(() => fs.rmSync(alive, { force: true }));
  const rs = (...args) => { const r = script("run-state.mjs", p.dir, [...args, "--run", s.id], { env: ENV }); assert.equal(r.status, 0, r.stderr + r.stdout); return r; };
  rs("set", "route", "build"); rs("set", "branch", "feature/signup"); rs("set", "target_branch", "main");
  s.commit(changes, "Add the signup page");
  const head = () => s.git("rev-parse", "HEAD");
  write(s.run_dir, { "spec.md": title ? SPEC.replace("# Signup", `# ${title}`) : SPEC });
  assert.equal(script("pr-render.mjs", p.dir, ["--run", s.id], { env: ENV }).status, 0);
  write(s.run_dir, { "pr.json": JSON.stringify({ repo: "o/r", number: 7, url: "https://github.com/o/r/pull/7", head: "feature/signup", base: "main", draft: false, labels: ["factory"], comments: [] }) });
  const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), "factory-fixtures-")), at = (name) => path.join(fixtures, `${name}.json`);
  const reply = (name, value) => fs.writeFileSync(at(name), JSON.stringify(value));
  reply("opened", "");
  const fake = fakeClis({
    gh: [
      { match: /^api repos\/o\/r\/pulls\/7$/, file: at("pr") },
      ...apps.map((a) => ({ match: new RegExp(`^api -X GET repos/o/r/deployments -f sha=[0-9a-f]{40} -f environment=${preview[a.name]?.environment} -f per_page=10$`), file: at(`deployments-${a.name}`) })),
      ...apps.map((a, i) => ({ match: new RegExp(`^api repos/o/r/deployments/${100 + i}/statuses`), file: at(`statuses-${a.name}`) })),
      { match: /^api repos\/o\/r\/deployments\/(\d+)\/statuses\?per_page=1$/, file: at("statuses") },
    ],
    open: [{ match: /./, file: at("opened") }], "xdg-open": [{ match: /./, file: at("opened") }],
  });
  reply("pr", { number: 7, head: { ref: "feature/signup", sha: head() }, base: { ref: "main" } });
  const preview_ = (...args) => script("preview.mjs", p.dir, [...args, "--run", s.id], { env: { ...ENV, PATH: fake.env.PATH } });
  const read = (f) => JSON.parse(fs.readFileSync(path.join(s.run_dir, f), "utf8"));
  return { p, s, bare, rs, head, reply, fake, preview: preview_, read };
}

test("github-deployment: a touched app's preview is the newest deployment at the head whose status is success with an environment_url", (t) => {
  const r = run(t);
  r.reply("deployments-web", [{ id: 12, environment: "Preview", sha: r.head() }, { id: 11, environment: "Preview", sha: r.head() }]);
  r.reply("statuses", [{ state: "success", environment_url: "https://signup-git-feature.vercel.app" }]);
  const out = r.preview();
  assert.equal(out.status, 0, out.stderr + out.stdout);
  const { apps, sha } = r.read("preview.json");
  assert.equal(sha, r.head());
  assert.deepEqual(apps.web, { mode: "github-deployment", touched: true, status: "ready", sha: r.head(), url: "https://signup-git-feature.vercel.app", deployment: 12 });
  assert.equal(apps.api.status, "none", "an app the run didn't touch waits on no deployment");
  assert.equal(apps.api.touched, false);
  const calls = r.fake.calls("gh").map((a) => a.join(" "));
  assert.ok(calls.some((c) => c.startsWith(`api -X GET repos/o/r/deployments -f sha=${r.head()} -f environment=Preview `)), calls.join("\n"));
  assert.ok(!calls.some((c) => c.includes("Preview – api")), "nothing is read for the untouched app");
  assert.match(out.stdout, /^PREVIEW web=ready https:\/\/signup-git-feature\.vercel\.app api=none/m);
});

test("github-deployment: a failed deployment is failed at once, one still pending is timeout when the wait runs out, and neither fails the run", (t) => {
  const r = run(t, { changes: { "web/page.js": "a\n", "api/route.js": "b\n" } });
  r.reply("deployments-web", [{ id: 21, environment: "Preview", sha: r.head() }]);
  r.reply("deployments-api", [{ id: 31, environment: "Preview – api", sha: r.head() }]);
  r.reply("statuses", [{ state: "failure", description: "Build failed" }]);
  let started = Date.now(), out = r.preview("--wait", "600", "--poll", "0.05");
  assert.equal(out.status, 0, out.stderr);
  assert.ok(Date.now() - started < 5000, "a failure isn't waited out");
  let { apps } = r.read("preview.json");
  assert.deepEqual([apps.web.status, apps.web.reason, apps.web.deployment], ["failed", "deployment 21 failure: Build failed", 21]);
  assert.equal(apps.api.status, "failed");

  // a newer deployment still in progress is waited on, past an older one's failure
  r.reply("deployments-web", [{ id: 100, environment: "Preview" }, { id: 101, environment: "Preview" }]);
  r.reply("statuses-web", [{ state: "in_progress" }]); r.reply("statuses-api", [{ state: "failure" }]);
  r.preview("--wait", "0.2", "--poll", "0.05");
  assert.equal(r.read("preview.json").apps.web.status, "timeout");

  r.reply("statuses", [{ state: "in_progress" }]);
  started = Date.now(); out = r.preview("--wait", "0.4", "--poll", "0.05");
  assert.equal(out.status, 0, out.stderr);
  assert.ok(Date.now() - started < 5000, "the wait is the budget given");
  apps = r.read("preview.json").apps;
  assert.equal(apps.web.status, "timeout");
  assert.match(apps.api.reason, /^no deployment of [0-9a-f]{7} in Preview – api reported success with an environment_url in 0\.4s$/);
  const polls = r.fake.calls("gh").filter((a) => a.join(" ").includes("environment=Preview – api")).length;
  assert.ok(polls >= 4, `read again every --poll seconds until the wait ran out: ${polls} reads`);

  // GitHub refuses every call
  fs.writeFileSync(path.join(r.fake.bin, "gh"), "#!/bin/sh\necho 'HTTP 502: Bad Gateway' >&2\nexit 1\n");
  out = r.preview("--wait", "0.1", "--poll", "0.05");
  assert.equal(out.status, 0, out.stderr);
  apps = r.read("preview.json").apps;
  assert.deepEqual([apps.web.status, apps.api.status], ["timeout", "timeout"]);
  assert.match(apps.web.reason, /\(GitHub: HTTP 502: Bad Gateway\)$/);
});

test("command: the PR title reaches the shell only as a quoted env ref, so an injection in it runs nothing, and the URL comes from a JSON path", (t) => {
  const title = `Signup $(touch pwned1) \`touch pwned2\` "; touch pwned3; " '; touch pwned4; '`;
  const MOBILE = { name: "ios", type: "mobile", path: "mobile", build: "true" };
  const r = run(t, {
    title, apps: [...APPS, MOBILE], changes: { "web/page.js": "a\n", "api/route.js": "b\n", "mobile/ios/Podfile": "c\n" },
    preview: {
      web: { mode: "command", command: `printf '%s' {title} > title.txt; printf '%s' {branch} > branch.txt; printf '{"deploy":{"urls":["https://pr-%s.preview.test"]}}' {sha}`, url_from: "deploy.urls[0]" },
      api: { mode: "fixed", url: "https://api.staging.test" },
      ios: { mode: "command", command: "touch ran.txt; echo '{\"url\":\"https://expo.test\"}'", url_from: "url" },
    },
  });
  write(r.s.run_dir, { "touches.json": JSON.stringify({ head: r.head(), touches: { native: { hit: true, paths: ["mobile/ios/Podfile"] } } }) });
  const out = r.preview();
  assert.equal(out.status, 0, out.stderr + out.stdout);
  const web = path.join(r.s.worktree, "web");
  assert.equal(fs.readFileSync(path.join(web, "title.txt"), "utf8"), title, "the title arrives as one word, as written");
  assert.equal(fs.readFileSync(path.join(web, "branch.txt"), "utf8"), "feature/signup");
  assert.deepEqual(fs.readdirSync(web).filter((f) => f.startsWith("pwned")), [], "nothing in the title ran");
  const { apps } = r.read("preview.json");
  assert.deepEqual([apps.web.status, apps.web.url, apps.web.sha], ["ready", `https://pr-${r.head()}.preview.test`, r.head()]);
  assert.deepEqual([apps.api.mode, apps.api.status, apps.api.url], ["fixed", "ready", "https://api.staging.test"]);
  assert.deepEqual([apps.ios.status, apps.ios.reason], ["none", "native change, needs a new build"]);
  assert.equal(fs.existsSync(path.join(r.s.worktree, "mobile/ran.txt")), false, "a native change runs no preview command");

  // a URL that isn't http(s), or a command that fails, is failed with its log; an app with no preview entry is local
  write(r.s.worktree, { ".factory/setup.json": JSON.stringify({ apps: [...APPS, MOBILE], preview: {
    web: { mode: "command", command: `echo '{"url":"javascript:alert(1)"}'`, url_from: "url" },
    api: { mode: "command", command: "echo nope >&2; exit 3", url_from: "url" },
  } }) });
  r.preview();
  const after = r.read("preview.json").apps;
  assert.deepEqual([after.web.status, after.web.reason], ["failed", "its output has no http(s) URL at url"]);
  assert.deepEqual([after.api.status, after.api.reason], ["failed", "the command exited 3"]);
  assert.equal(fs.readFileSync(after.api.log, "utf8"), "nope\n");
  assert.deepEqual(after.ios, { mode: "local", touched: true, status: "none", sha: r.head() });

  // with no touches.json of the head, no mobile preview is read; an entry with no command is failed, and never a crash
  fs.rmSync(path.join(r.s.run_dir, "touches.json"));
  write(r.s.worktree, { ".factory/setup.json": JSON.stringify({ apps: [...APPS, MOBILE], preview: { web: { mode: "command" }, ios: { mode: "command", command: "touch ran.txt", url_from: "url" } } }) });
  assert.equal(r.preview().status, 0);
  const last = r.read("preview.json").apps;
  assert.equal(last.web.status, "failed");
  assert.deepEqual([last.ios.status, last.ios.reason], ["none", "no touches.json of the head rules out a native change"]);
  assert.equal(fs.existsSync(path.join(r.s.worktree, "mobile/ran.txt")), false);
});

// The run's previews read once: each app's deployment at the head reports success, but api's when `api` is false,
// which has no deployment yet.
function previewed(r, { api = true } = {}) {
  r.reply("deployments-web", [{ id: 100, environment: "Preview" }]); r.reply("deployments-api", api ? [{ id: 101, environment: "Preview – api" }] : []);
  r.reply("statuses-web", [{ state: "success", environment_url: "https://signup-git-feature.vercel.app" }]);
  r.reply("statuses-api", [{ state: "success", environment_url: "https://api-git-feature.vercel.app/" }]);
  const out = r.preview("--wait", "0");
  assert.equal(out.status, 0, out.stderr);
}
const opened = (r) => [...r.fake.calls("open"), ...r.fake.calls("xdg-open")];
const tryIt = (r, ...args) => script("preview.mjs", r.p.dir, ["try", "--run", r.s.id, ...args], { env: { ...ENV, PATH: r.fake.env.PATH } });

test("try: with every touched app's preview ready at the PR's head, read over REST, it prints the steps on the preview and opens the first route, starting nothing", (t) => {
  const r = run(t);
  previewed(r);
  const out = tryIt(r);
  assert.equal(out.status, 0, out.stderr + out.stdout);
  assert.match(out.stdout, new RegExp(`^PREVIEW at ${r.head().slice(0, 7)}, the PR's head\n- web: https://signup-git-feature\\.vercel\\.app\n`));
  assert.match(out.stdout, /^1\. SC-001: open `https:\/\/signup-git-feature\.vercel\.app\/signup`; /m);
  assert.match(out.stdout, /^2\. SC-002: The account exists afterwards\.$/m);
  assert.deepEqual(opened(r), [["https://signup-git-feature.vercel.app/signup"]]);
  assert.ok(r.fake.calls("gh").some((a) => a.join(" ") === "api repos/o/r/pulls/7"), "the PR's head is read over REST");
  assert.equal(fs.existsSync(path.join(r.s.run_dir, "apps.json")), false, "no app is started");
});

const get = (url) => fetch(url).then((res) => res.json());
const answers = (url) => fetch(url).then(() => true, () => false);

test("try: a stale head (the PR moved past the preview's sha) falls back to every app started locally in the run worktree, until --done", async (t) => {
  const r = run(t, { changes: { "web/page.js": "a\n", "api/route.js": "b\n" } });
  previewed(r);
  r.reply("pr", { number: 7, head: { ref: "feature/signup", sha: "f".repeat(40) }, base: { ref: "main" } });
  t.after(() => tryIt(r, "--done"));
  const out = tryIt(r);
  assert.equal(out.status, 0, out.stderr + out.stdout);
  assert.equal(out.stdout.split("\n")[0], `LOCAL: stale head: the preview is of ${r.head().slice(0, 7)}, the PR's head is fffffff`);
  const { apps } = r.read("apps.json");
  for (const app of ["web", "api"]) assert.equal((await get(apps[app].url)).cwd, path.join(r.s.worktree, app), `${app} runs in the run worktree`);
  assert.match(out.stdout, new RegExp(`^- web: http://localhost:${apps.web.port}/$`, "m"));
  assert.match(out.stdout, new RegExp(`^1\\. SC-001: open \`http://localhost:${apps.web.port}/signup\`; `, "m"));
  assert.doesNotMatch(out.stdout, /vercel\.app/, "no preview mixed in");
  assert.deepEqual(opened(r), [[`http://localhost:${apps.web.port}/signup`]]);

  const done = tryIt(r, "--done");
  assert.equal(done.status, 0, done.stderr + done.stdout);
  assert.equal(await answers(apps.web.url), false, "--done brings them down");
  assert.equal(await answers(apps.api.url), false);
});

test("try: on an ended run with one touched app's preview not ready, every app starts locally in a worktree of the PR at its head, removed by --done", async (t) => {
  const r = run(t, { changes: { "web/page.js": "a\n", "api/route.js": "b\n" } });
  previewed(r, { api: false });
  r.s.git("push", "-q", "origin", "HEAD:refs/pull/7/head");  // GitHub's ref for the PR, which outlives its branch
  const head = r.head();
  r.rs("set", "stage", "delivered"); r.rs("snapshot");
  assert.equal(fs.existsSync(r.s.worktree), false, "the run's worktree is gone");
  const temp = `${r.s.worktree}-try`;
  t.after(() => tryIt(r, "--done"));
  const out = tryIt(r);
  assert.equal(out.status, 0, out.stderr + out.stdout);
  assert.match(out.stdout.split("\n")[0], /^LOCAL: not ready: api timeout \(no deployment of [0-9a-f]{7} in Preview – api reported success/);
  assert.match(out.stdout, new RegExp(`^PR #7 at ${head.slice(0, 7)}, in ${temp}$`, "m"));
  const { apps } = JSON.parse(fs.readFileSync(path.join(temp, ".factory/runs", r.s.id, "apps.json"), "utf8"));
  assert.equal((await get(apps.web.url)).cwd, path.join(temp, "web"), "web runs locally too, though its preview was ready");
  assert.equal((await get(apps.api.url)).cwd, path.join(temp, "api"));
  assert.doesNotMatch(out.stdout, /vercel\.app/);

  const done = tryIt(r, "--done");
  assert.equal(done.status, 0, done.stderr + done.stdout);
  assert.equal(await answers(apps.web.url), false);
  assert.equal(fs.existsSync(temp), false, "the PR's worktree is removed");
  assert.doesNotMatch(r.p.git("worktree", "list"), /-try/);
});
