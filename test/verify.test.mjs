// verify.test.mjs — verify.mjs spawned as a process against a run on a throwaway project.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { project, sh, STUB_SERVER } from "./harness.mjs";

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugin/scripts");
const node = (script, cwd, args, { input = "", env = process.env } = {}) =>
  spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { cwd, input, env, encoding: "utf8" });
const git = (cwd, ...args) => sh(cwd, "git", args);

// A run started on a project whose main commit holds `recipe` and `files`. verify(mode) runs verify.mjs from the main
// checkout, as the orchestrator does, and returns its result with the evidence it wrote.
function run(recipe, files = {}) {
  const p = project({ recipe });
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(p.dir, f)), { recursive: true });
    fs.writeFileSync(path.join(p.dir, f), text);
  }
  if (Object.keys(files).length) { p.git("add", "."); p.git("commit", "-qm", "product"); }
  const r = node("run-state.mjs", p.dir, ["init"], { input: "Add a CSV export\n" });
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  const verify = (mode, env) => {
    const v = node("verify.mjs", p.dir, [mode, "--run", s.id], { env });
    const file = path.join(s.run_dir, mode === "--full" ? "evidence.json" : "evidence-fast.json");
    return { ...v, evidence: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null };
  };
  return { ...p, s, wt: s.worktree, verify };
}
const statuses = (e) => e.checks.map((c) => `${c.app}/${c.check}=${c.status}`);

test("verify runs every check for every app past a failure, saves each one's output and pins the evidence to HEAD", () => {
  const p = run({ apps: [
    { name: "web", path: "web", checks: { lint: "pwd", test: "echo boom; exit 1", e2e: "echo e2e ran" } },
    { name: "api", path: ".", checks: { test: "echo api ok" } },
  ] }, { "web/index.js": "1\n" });
  const fast = p.verify("--fast");
  assert.equal(fast.status, 1, fast.stderr);
  assert.deepEqual(statuses(fast.evidence), ["web/lint=pass", "web/test=fail", "api/test=pass"], "--fast runs typecheck, lint and test only");
  assert.equal(fast.evidence.checks[0].log, path.join(p.s.run_dir, "logs", "web-lint.fast.log"), "a fast log never overwrites a full one");
  const full = p.verify("--full");
  assert.equal(full.status, 1, full.stderr);
  const e = full.evidence;
  assert.deepEqual(statuses(e), ["web/lint=pass", "web/test=fail", "web/e2e=pass", "api/test=pass"]);
  assert.equal(e.sha, git(p.wt, "rev-parse", "HEAD"));
  assert.deepEqual([e.green, e.dirty, e.trusted, e.red_cause], [false, false, true, "inherited"], "web/test fails at the base too");
  const [lint, red, e2e] = e.checks;
  assert.equal(lint.log, path.join(p.s.run_dir, "logs", "web-lint.log"));
  assert.equal(fs.readFileSync(lint.log, "utf8"), path.join(p.wt, "web") + "\n", "a check runs in its app's path");
  assert.equal(fs.readFileSync(e2e.log, "utf8"), "e2e ran\n");
  assert.equal(red.digest, `boom\nfull output: ${red.log}`);
  assert.equal(lint.digest, null, "only a failing check has a digest");
  assert.match(full.stdout, new RegExp(`^--- web/test fail\nboom\nfull output: ${red.log}$`, "m"));
  assert.equal(git(p.wt, "status", "--porcelain"), "", "the evidence and logs never dirty the tree");
});

test("an app without a test check fails it, since a required check missing from the recipe is a failure", () => {
  const p = run({ apps: [{ name: "web", path: ".", checks: { lint: "true" } }, { name: "api", path: ".", checks: { test: "true" } }] });
  const r = p.verify("--full");
  assert.equal(r.status, 1);
  assert.deepEqual(statuses(r.evidence), ["web/lint=pass", "web/test=fail", "api/test=pass"]);
  const missing = r.evidence.checks[1];
  assert.deepEqual([missing.cmd, missing.log, missing.digest], [null, null, "required check not in recipe"]);
  assert.deepEqual([r.evidence.green, r.evidence.red_cause], [false, "inherited"], "the base's recipe lacks it too");
});

test("checks see only .factory/env.local, and a check needing a name it doesn't hold is skipped", () => {
  const p = run({ apps: [{ name: "api", path: ".", checks: {
    test: { cmd: "env", env: ["DATABASE_URL"] },
    integration: { cmd: "echo charged a card", env: ["DATABASE_URL", "STRIPE_SECRET_KEY"] },
  } }] });
  fs.writeFileSync(path.join(p.dir, ".factory/env.local"), "export DATABASE_URL='postgres://localhost:5432/app'\nAPP_MODE=dev # a comment\n");
  const r = p.verify("--full", { ...process.env, DEVELOPER_ONLY: "from my shell" });
  assert.equal(r.status, 1);
  const [unit, integration] = r.evidence.checks;
  assert.equal(unit.status, "pass");
  const seen = fs.readFileSync(unit.log, "utf8").split("\n");
  for (const line of ["DATABASE_URL=postgres://localhost:5432/app", "APP_MODE=dev", `PATH=${process.env.PATH}`]) assert.ok(seen.includes(line), line);
  assert.ok(!seen.some((l) => l.startsWith("DEVELOPER_ONLY=")), "the developer's shell never reaches a check");
  assert.deepEqual([integration.status, integration.log, integration.digest], ["skipped", null, "STRIPE_SECRET_KEY not available in .factory/env.local"]);
  assert.ok(!fs.existsSync(path.join(p.s.run_dir, "logs", "api-integration.log")), "a skipped check never runs");
  assert.deepEqual([r.evidence.green, r.evidence.red_cause], [false, "environment"], "skipped is never a pass");
  fs.writeFileSync(path.join(p.wt, "app.js"), "uncommitted\n");
  assert.equal(p.verify("--full").evidence.red_cause, "incomplete", "uncommitted work comes before the environment");
});

test("the evidence is dirty on an unclean tree or a moved HEAD, with .factory/ left out except the recipe", () => {
  const p = run({ apps: [{ name: "app", path: ".", checks: { test: "true" } }] });
  fs.writeFileSync(path.join(p.wt, ".factory/index.md"), "bookkeeping\n");
  fs.appendFileSync(path.join(p.wt, ".factory/config.json"), "\n");
  let r = p.verify("--full");
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual([r.evidence.green, r.evidence.dirty, r.evidence.red_cause], [true, false, null], "bookkeeping under .factory/ isn't product");
  fs.writeFileSync(path.join(p.wt, "app.js"), "uncommitted\n");
  r = p.verify("--full");
  assert.equal(r.status, 1);
  assert.deepEqual([r.evidence.green, r.evidence.dirty, r.evidence.dirty_detail], [false, true, ["?? app.js"]]);
  assert.equal(r.evidence.red_cause, "incomplete", "every check passed, on work not yet committed");
  const moved = run({ apps: [{ name: "app", path: ".", checks: { test: "git commit -q --allow-empty -m moved" } }] });
  r = moved.verify("--full");
  assert.equal(r.status, 1);
  assert.equal(r.evidence.checks[0].status, "pass");
  assert.deepEqual([r.evidence.dirty, r.evidence.sha], [true, git(moved.wt, "rev-parse", "HEAD")], "HEAD moved while the checks ran");
});

test("the evidence is trusted only while the recipe on disk equals the committed one", () => {
  const p = run({ apps: [{ name: "app", path: ".", checks: { test: "true" } }] });
  const recipe = path.join(p.wt, ".factory/setup.json");
  fs.writeFileSync(recipe, JSON.stringify({ apps: [{ name: "app", path: ".", checks: { test: "true", lint: "true" } }] }));
  let r = p.verify("--full");
  assert.equal(r.status, 1);
  assert.deepEqual([r.evidence.green, r.evidence.trusted, r.evidence.dirty], [false, false, true], "the recipe is never left out of the dirty check");
  git(p.wt, "commit", "-qam", "add a lint check");
  r = p.verify("--full");
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual([r.evidence.green, r.evidence.trusted, r.evidence.dirty], [true, true, false]);
});

test("{base} reaches a check as the base branch's quoted value, so a branch name never runs as shell", () => {
  const p = run({ apps: [{ name: "app", path: ".", checks: { test: "printf '%s\\n' {base}" } }] });
  const base = "main$(touch pwned-1)`touch pwned-2`;touch pwned-3";
  assert.equal(node("run-state.mjs", p.dir, ["set", "base_branch", base, "--run", p.s.id]).status, 0);
  const r = p.verify("--full");
  assert.equal(r.status, 0, r.stdout);
  assert.equal(fs.readFileSync(r.evidence.checks[0].log, "utf8"), base + "\n");
  for (const dir of [p.wt, p.dir]) assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith("pwned")), []);
});

test("the digest keeps a failure from the middle of a long log, quoted verbatim, in at most 40 lines", () => {
  const cause = "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\t 3 !== 4  ";
  const log = [
    ...Array.from({ length: 300 }, (_, i) => `step ${i} ok`), cause,
    ...Array.from({ length: 80 }, (_, i) => `Error: cascade ${i}`),
    ...Array.from({ length: 300 }, (_, i) => `step ${300 + i} ok`), "1 of 681 checks red",
  ];
  const p = run({ apps: [{ name: "app", path: ".", checks: { test: "cat out.txt; exit 1" } }] }, { "out.txt": log.join("\n") + "\n" });
  const r = p.verify("--full");
  const c = r.evidence.checks[0];
  assert.equal(fs.readFileSync(c.log, "utf8"), log.join("\n") + "\n", "the full output is saved");
  const lines = c.digest.split("\n");
  assert.ok(lines.length <= 40, `${lines.length} lines`);
  assert.equal(lines[0], cause, "the first matching line, word for word");
  assert.ok(lines.includes("Error: cascade 0"));
  assert.ok(!lines.includes("Error: cascade 79"), "later matches give way to the end of the log");
  assert.deepEqual(lines.slice(-3), ["step 599 ok", "1 of 681 checks red", `full output: ${c.log}`]);
  assert.ok(r.stdout.includes(`--- app/test fail\n${c.digest}\n`), "verify prints the digest, not the log");
});

test("a red is inherited when the failing check fails at the base commit too, after the recipe's setup, else introduced", () => {
  // .deps stands for installed dependencies: ignored, made by the recipe's setup, and missing from a fresh checkout.
  const recipe = (test) => ({ setup: "echo installed > .deps", apps: [{ name: "app", path: ".", checks: { test } }] });
  const at = (recipeOf, change) => {
    const p = run(recipeOf, { "ok.txt": "1\n" });
    fs.appendFileSync(path.join(p.dir, ".git/info/exclude"), ".deps\n");
    fs.writeFileSync(path.join(p.wt, ".deps"), "installed\n");
    change?.(p);
    return [p, p.verify("--full")];
  };
  const [p, introduced] = at(recipe("test -f .deps && test -f ok.txt"), (p) => { git(p.wt, "rm", "-q", "ok.txt"); git(p.wt, "commit", "-qm", "drop ok.txt"); });
  assert.equal(introduced.status, 1);
  const c = introduced.evidence.checks[0];
  assert.deepEqual([c.status, c.at_base.status, introduced.evidence.red_cause], ["fail", "pass", "introduced"]);
  assert.equal(c.at_base.log, path.join(p.s.run_dir, "logs", "app-test.at-base.log"));
  assert.deepEqual(p.git("worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")), [`worktree ${p.dir}`, `worktree ${p.wt}`], "the base's worktree is gone");
  const [, inherited] = at(recipe("test -f .deps && test -f missing.txt"));
  assert.deepEqual([inherited.evidence.checks[0].at_base.status, inherited.evidence.red_cause], ["fail", "inherited"]);
});

test("fix 1: run state written mid-run leaves the evidence clean and pinned to HEAD, and a snapshot to the base doesn't move it", () => {
  const p = run({ apps: [{ name: "app", path: ".", checks: { test: "test -f app.js" } }] });
  const rs = (...args) => assert.equal(node("run-state.mjs", p.dir, [...args, "--run", p.s.id]).status, 0, args[0]);
  git(p.wt, "switch", "-q", "-c", "feature/csv-export");
  fs.writeFileSync(path.join(p.wt, "app.js"), "export const csv = () => 'a,b';\n");
  git(p.wt, "add", "app.js"); git(p.wt, "commit", "-qm", "csv export");
  rs("dispatch", "implement");
  rs("done", "implement");
  const r = p.verify("--full");
  assert.equal(r.status, 0, r.stdout);
  const head = git(p.wt, "rev-parse", "HEAD");
  assert.deepEqual([r.evidence.sha, r.evidence.green, r.evidence.dirty], [head, true, false]);
  assert.equal(git(p.wt, "status", "--porcelain"), "", "state.json, run.log, the evidence and its logs never dirty the run worktree");
  rs("set", "stage", "needs-human");
  rs("snapshot");
  assert.match(p.git("log", "-1", "--format=%s", "main"), /snapshot/, "the snapshot landed on the base");
  assert.equal(git(p.wt, "rev-parse", "HEAD"), head, "the bookkeeping commit never moves the run's HEAD");
  const again = p.verify("--full");
  assert.deepEqual([again.status, again.evidence.sha, again.evidence.dirty], [0, head, false]);
});

// A run whose project holds the stub server too, with ALIVE (the file every stub lives by) and `env` in
// .factory/env.local. After the test, pass or fail, the run's apps are brought down and ALIVE goes.
function withApps(t, recipe, files, env = {}) {
  const p = run(recipe, { "server.mjs": STUB_SERVER, ...files });
  const alive = path.join(p.dir, ".alive");
  fs.writeFileSync(alive, "");
  fs.writeFileSync(path.join(p.dir, ".factory/env.local"), Object.entries({ ALIVE: alive, ...env }).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  t.after(() => { node("run-apps.mjs", p.dir, ["down", "--run", p.s.id]); fs.rmSync(alive, { force: true }); });
  return p;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

test("a check its app lists in needs_apps runs while the run's apps are up, with {port:<app>} and {db} filled in, and the apps go down after it", (t) => {
  const probe = "const url = process.argv[2], seen = await (await fetch(url)).json();\n"
    + "console.log(JSON.stringify({ url, pid: seen.pid, cwd: seen.cwd, API_URL: process.env.API_URL, DATABASE_URL: process.env.DATABASE_URL }));\n";
  const p = withApps(t, {
    apps: [{ name: "api", path: ".", dev: "PORT={port:api} node server.mjs", health: "http://localhost:{port:api}/",
      checks: { test: "true", integration: "node probe.mjs http://localhost:{port:api}/" }, needs_apps: ["integration"] }],
    db: { create: "true", drop: "true" },
  }, { "probe.mjs": probe }, { API_URL: "http://localhost:{port:api}/v1", DATABASE_URL: "postgres://localhost:5432/{db}" });
  const r = p.verify("--full");
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(statuses(r.evidence), ["api/test=pass", "api/integration=pass"]);
  const seen = JSON.parse(fs.readFileSync(r.evidence.checks[1].log, "utf8"));
  assert.match(seen.url, /^http:\/\/localhost:\d+\/$/);
  assert.equal(seen.cwd, p.wt, "the check reached the run's own app");
  const { db, apps } = JSON.parse(fs.readFileSync(path.join(p.s.run_dir, "apps.json"), "utf8"));
  assert.deepEqual([seen.API_URL, seen.DATABASE_URL], [`${seen.url}v1`, `postgres://localhost:5432/${db}`]);
  assert.deepEqual(apps, {});
  assert.ok(!alive(seen.pid), "the apps went down after the check");
  assert.equal(r.evidence.dirty, false, "apps.json and the apps' logs never dirty the tree");
});

test("run in a ticket's worktree, verify checks that worktree, with its apps started from it, and writes beside the ticket's plan", (t) => {
  const probe = "console.log((await (await fetch(process.argv[2])).json()).cwd);\n";
  const p = withApps(t, { apps: [{ name: "api", path: ".", dev: "PORT={port:api} node server.mjs", health: "http://localhost:{port:api}/",
    checks: { test: "test -f csv.js", integration: "node probe.mjs http://localhost:{port:api}/" }, needs_apps: ["integration"] }] }, { "probe.mjs": probe });
  const ticket = path.join(p.dir, ".factory/worktrees", `${p.s.id}-01`);
  p.git("worktree", "add", "-q", "-b", `factory/${p.s.id}/01`, ticket, git(p.wt, "rev-parse", "HEAD"));
  fs.writeFileSync(path.join(ticket, "csv.js"), "1\n");
  git(ticket, "add", "csv.js"); git(ticket, "commit", "-qm", "csv");
  const r = node("verify.mjs", ticket, ["--full", "--run", p.s.id]);
  assert.equal(r.status, 0, r.stdout);
  const out = path.join(p.s.run_dir, "tickets", "01"), e = JSON.parse(fs.readFileSync(path.join(out, "evidence.json"), "utf8"));
  assert.deepEqual([e.sha, e.green, statuses(e)], [git(ticket, "rev-parse", "HEAD"), true, ["api/test=pass", "api/integration=pass"]]);
  assert.equal(fs.readFileSync(path.join(out, "logs", "api-integration.log"), "utf8"), ticket + "\n", "the app ran from the ticket's worktree");
  assert.ok(!fs.existsSync(path.join(p.s.run_dir, "evidence.json")), "the run head's evidence is untouched");
});

test("a check that needs apps which won't come up is skipped with up's digest, a red the environment caused", (t) => {
  const p = withApps(t, { apps: [{ name: "api", path: ".", dev: "echo 'Error: connect ECONNREFUSED 127.0.0.1:5432'; exit 1",
    health: "http://localhost:{port:api}/", checks: { test: "true", integration: "echo ran" }, needs_apps: ["integration"] }] }, {});
  const r = p.verify("--full");
  assert.equal(r.status, 1);
  const c = r.evidence.checks[1];
  assert.deepEqual([c.status, r.evidence.red_cause], ["skipped", "environment"]);
  assert.match(c.digest, /^run-apps up failed\n/);
  assert.match(c.digest, /Error: connect ECONNREFUSED 127\.0\.0\.1:5432/);
  assert.ok(c.digest.endsWith(`full output: ${c.log}`));
  assert.doesNotMatch(fs.readFileSync(c.log, "utf8"), /^ran$/m, "the check never ran");
});

test("fix 15: verify --full brings down a stack left up, so an e2e suite that starts its own server gets its port", async (t) => {
  const port = await freePort();
  const e2e = "const s = (await import('node:http')).createServer((q, res) => res.end('e2e ran')).listen(Number(process.argv[2]));\n"
    + "s.on('error', (e) => { console.error(`Error: ${e.code}`); process.exit(1); });\n"
    + "s.on('listening', async () => { console.log(await (await fetch(`http://localhost:${process.argv[2]}/`)).text()); process.exit(0); });\n";
  const p = withApps(t, { apps: [{ name: "web", path: ".", dev: `node server.mjs ${port}`, health: `http://localhost:${port}/`,
    checks: { test: "true", e2e: `node e2e.mjs ${port}` } }] }, { "e2e.mjs": e2e });
  const up = node("run-apps.mjs", p.dir, ["up", "--run", p.s.id]);
  assert.equal(up.status, 0, up.stdout + up.stderr);
  const { pid } = await (await fetch(`http://localhost:${port}/`)).json();
  const r = p.verify("--full");
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(statuses(r.evidence), ["web/test=pass", "web/e2e=pass"]);
  assert.equal(fs.readFileSync(r.evidence.checks[1].log, "utf8"), "e2e ran\n");
  assert.ok(!alive(pid), "the stack is down afterwards");
});
