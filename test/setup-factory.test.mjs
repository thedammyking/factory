// setup-factory.test.mjs — setup-factory.mjs spawned as a process against throwaway projects, with a fake gh on PATH.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { project, fakeClis } from "./harness.mjs";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugin/scripts/setup-factory.mjs");
const scratch = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
// node, npm and git from the real PATH, and nothing else from it: a scanner or gh installed on this machine never reaches
// detection, which sees only these, the fakes and /usr/bin:/bin.
const TOOLS = scratch("factory-tools-");
for (const t of ["node", "npm", "git"]) {
  const found = process.env.PATH.split(path.delimiter).map((d) => path.join(d, t)).find((f) => fs.existsSync(f));
  fs.symlinkSync(found, path.join(TOOLS, t));
}
const CANNED = scratch("factory-canned-");
const canned = (name, body) => { const f = path.join(CANNED, name); fs.writeFileSync(f, typeof body === "string" ? body : JSON.stringify(body)); return f; };
const EMPTY = canned("empty", "");
const REPO = { default_branch: "main", allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: true };

// A fake gh (signed in unless `auth` is false, answering the repo read and the deployments read), a fake claude that
// records any call, and any other fakes given (`{ gitleaks: [] }` makes gitleaks installed).
function fakes({ auth = true, repo = REPO, deployments = [], ...more } = {}) {
  const f = fakeClis({
    gh: [
      { match: /^auth status/, file: EMPTY, status: auth ? 0 : 1 },
      { match: /^api repos\/acme\/shop$/, file: canned(`repo-${Math.random()}`, repo) },
      { match: /^api repos\/acme\/shop\/deployments/, file: canned(`deployments-${Math.random()}`, deployments) },
    ],
    claude: [],
    ...more,
  });
  return { ...f, env: { PATH: [f.bin, TOOLS, "/usr/bin", "/bin"].join(path.delimiter), HOME: process.env.HOME, TMPDIR: os.tmpdir() } };
}
const run = (p, f, args, input = "") => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: p.dir, input, encoding: "utf8", env: f.env });

const json = (o) => JSON.stringify(o, null, 2) + "\n";
const script = (body) => `node -e ${JSON.stringify(body)}`;
// A Next.js app plus an API, in npm workspaces. The web app's dev server listens on --port, the API's on $PORT.
const SHOP = {
  "package.json": json({ name: "shop", private: true, workspaces: ["apps/*", "packages/*"] }),
  "apps/web/package.json": json({
    name: "@shop/web",
    scripts: { dev: "node server.js", lint: script("0"), typecheck: script("0"), test: script("0"), e2e: script("0") },
    dependencies: { next: "15.0.0", "next-auth": "5.0.0" },
    devDependencies: { "@playwright/test": "1.50.0", "@axe-core/playwright": "4.10.0" },
  }),
  "apps/web/next.config.mjs": "export default {};\n",
  "apps/web/playwright.config.ts": "export default { testDir: './tests/e2e' };\n",
  "apps/web/server.js": `require("node:http").createServer((q, s) => s.end("web")).listen(Number(process.argv[process.argv.indexOf("--port") + 1]));\n`,
  "apps/api/package.json": json({
    name: "@shop/api",
    scripts: { "start:dev": "node server.js", build: script("0"), test: script("0"), "test:integration": script("0") },
    dependencies: { "@nestjs/core": "10.0.0" },
  }),
  "apps/api/nest-cli.json": "{}\n",
  "apps/api/server.js": `require("node:http").createServer((q, s) => { s.statusCode = 404; s.end(); }).listen(Number(process.env.PORT));\n`,
  "packages/ui/package.json": json({ name: "@shop/ui", scripts: { lint: script("0") } }),
  "packages/config/package.json": json({ name: "@shop/config" }),
};

// A throwaway git project holding `files` and no .factory/, with a GitHub origin unless `remote` is null.
function shop({ files = SHOP, remote = "https://github.com/acme/shop.git", develop = false } = {}) {
  const p = project();
  p.git("rm", "-rq", ".factory", ".gitignore");
  fs.rmSync(path.join(p.dir, ".factory"), { recursive: true, force: true });
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(p.dir, f)), { recursive: true });
    fs.writeFileSync(path.join(p.dir, f), body);
  }
  p.git("add", "-A"); p.git("commit", "-qm", "shop");
  if (remote) p.git("remote", "add", "origin", remote);
  if (develop) p.git("branch", "develop");
  return p;
}
const untouched = (p) => {
  assert.equal(p.git("status", "--porcelain", "--ignored"), "", "setup wrote nothing in the project");
};
const read = (p, f) => fs.readFileSync(path.join(p.dir, f), "utf8");

test("no package.json, no GitHub remote or a failing gh auth status stops setup with the fix, writing nothing", () => {
  const noPackage = shop({ files: { "README.md": "hi\n" } });
  let r = run(noPackage, fakes(), ["detect"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no package\.json.*\n.*npm init/i);
  untouched(noPackage);

  const noRemote = shop({ remote: null });
  r = run(noRemote, fakes(), ["detect"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no GitHub remote.*\n.*git remote add origin/i);
  untouched(noRemote);

  const otherHost = shop({ remote: "https://gitlab.com/acme/shop.git" });
  r = run(otherHost, fakes(), ["detect"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no GitHub remote/i);

  const signedOut = shop();
  r = run(signedOut, fakes({ auth: false }), ["detect"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /gh isn't signed in.*\n.*gh auth login/i);
  untouched(signedOut);
});

const detect = (p, f, args = []) => {
  const r = run(p, f, ["detect", ...args]);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const source = (d, field) => d.sources.find((s) => s.field === field);

test("detect on trunk with no deployments prints the apps, their checks, dev, health, pinned dirs, branching, merge method, scanners, previews and auth", () => {
  const p = shop();
  const f = fakes({ repo: { ...REPO, allow_squash_merge: false }, gitleaks: [] });
  const d = detect(p, f);
  assert.deepEqual(d.recipe.apps, [
    {
      name: "api", type: "backend", path: "apps/api",
      dev: "PORT={port:api} npm run start:dev", health: "http://localhost:{port:api}/",
      checks: { test: "npm run test", build: "npm run build", integration: "npm run test:integration" },
      needs_apps: ["integration"],
    },
    {
      name: "web", type: "web", path: "apps/web",
      dev: "npm run dev -- --port {port:web}", health: "http://localhost:{port:web}/",
      checks: { typecheck: "npm run typecheck", lint: "npm run lint", test: "npm run test", e2e: "npm run e2e" },
      needs_apps: ["e2e"],
    },
    { name: "ui", type: "other", path: "packages/ui", checks: { lint: "npm run lint" } },
  ]);
  assert.deepEqual(d.recipe.pinned, ["apps/api/e2e", "apps/web/tests/e2e"], "the Playwright testDir, else <app>/e2e");
  assert.deepEqual(source(d, "apps.ui.checks.test"), { field: "apps.ui.checks.test", value: null, source: "no test script, and verify fails an app without one", guess: false });
  assert.deepEqual(d.recipe.preview, { web: { mode: "local" }, api: { mode: "local" } });
  assert.deepEqual(d.config.branching, { model: "trunk", main: "main", prefixes: { feature: "feature/", bugfix: "bugfix/", hotfix: "hotfix/" } });
  assert.equal(d.config.merge_method, "merge", "trunk squashes, but the repo allows no squash merge");
  assert.deepEqual(d.config.security, ["gitleaks", "audit"]);
  assert.deepEqual(d.scanners, { gitleaks: true, "osv-scanner": false, semgrep: false });
  assert.deepEqual(d.auth, { web: "Auth.js" });
  assert.equal(d.tracker, "github");
  assert.deepEqual(source(d, "apps.web.type"), { field: "apps.web.type", value: "web", source: "apps/web/next.config.mjs", guess: false });
  assert.deepEqual(source(d, "apps.api.checks.integration"), { field: "apps.api.checks.integration", value: "npm run test:integration", source: "apps/api/package.json scripts.test:integration", guess: false });
  assert.match(source(d, "merge_method").source, /allow_squash_merge false/);
  assert.deepEqual(f.calls("gh"), [["auth", "status"], ["api", "repos/acme/shop"], ["api", "repos/acme/shop/deployments?per_page=100"]]);
  assert.deepEqual(f.calls("claude"), [], "MCP servers come from the session's tool list, never `claude mcp list`");
  untouched(p);
});

test("detect under git flow matches each app to a deployment environment naming it, guesses a web app's, and takes linear when its MCP is visible", () => {
  const p = shop({ develop: true });
  const deployments = [
    { environment: "Production – shop-api", production_environment: true },
    { environment: "Preview – shop-api" }, { environment: "Preview" }, { environment: "Preview" },
  ];
  const f = fakes({ deployments });
  const d = detect(p, f, ["--mcp", "linear,figma"]);
  assert.deepEqual(d.recipe.preview, {
    api: { mode: "github-deployment", environment: "Preview – shop-api" },
    web: { mode: "github-deployment", environment: "Preview" },
  });
  assert.equal(source(d, "preview.api").guess, false);
  assert.equal(source(d, "preview.web").guess, true, "no environment names web");
  assert.deepEqual(d.config.branching, { model: "git-flow", main: "main", develop: "develop", prefixes: { feature: "feature/", bugfix: "bugfix/", hotfix: "hotfix/" } });
  assert.equal(d.config.merge_method, "merge");
  assert.deepEqual([d.mcp, d.tracker], [["linear", "figma"], "linear"]);
  assert.equal(f.calls("gh").filter((c) => /deployments/.test(c[1])).length, 1, "one read of recent deployments");
  assert.deepEqual(f.calls("claude"), []);
  const developLine = (notes) => notes.some((n) => /`develop` isn't the default branch/.test(n));
  assert.ok(!developLine(d.notes), "GitHub's closing keywords don't matter to Linear");
  assert.ok(developLine(detect(p, f).notes), "under git flow, with GitHub as the tracker");
});

test("two workspace dirs sharing a name are told apart by their paths", () => {
  const p = shop({ files: { ...SHOP, "packages/api/package.json": json({ name: "@shop/api-client", scripts: { lint: script("0") } }) } });
  assert.deepEqual(detect(p, fakes()).recipe.apps.map((a) => [a.name, a.path]),
    [["apps-api", "apps/api"], ["web", "apps/web"], ["packages-api", "packages/api"], ["ui", "packages/ui"]]);
});

const proposal = (d) => JSON.parse(fs.readFileSync(d.file, "utf8"));

test("set refuses a field setup doesn't write, and the tracker, which is apply's answer", () => {
  const p = shop();
  const f = fakes();
  detect(p, f);
  for (const [field, why] of [["tracker", /--tracker/], ["package_manager", /isn't a field setup writes/], ["auth.web", /isn't a field setup writes/]]) {
    const r = run(p, f, ["set", field, "x"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, why);
  }
  assert.equal(run(p, f, ["set", "branching.model", "git-flow"]).status, 0);
  assert.equal(proposal({ file: path.join(p.dir, ".git/factory-setup.json") }).config.branching.model, "git-flow");
});

test("prove runs every check, dev command and health route once and records wall-clock seconds, writing nothing in the project", () => {
  const p = shop();
  const f = fakes();
  const d = detect(p, f);
  const r = run(p, f, ["prove"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const { proof } = proposal(d);
  assert.deepEqual(Object.keys(proof).sort(), [
    "api.build", "api.dev", "api.integration", "api.test", "ui.lint", "web.dev", "web.e2e", "web.lint", "web.test", "web.typecheck",
  ]);
  for (const [key, { status, seconds }] of Object.entries(proof)) {
    assert.equal(status, "pass", key);
    assert.ok(seconds >= 0 && seconds < 60, `${key} took ${seconds}s`);
  }
  assert.equal(proof["web.dev"].cmd, "npm run dev -- --port {port:web}");
  assert.match(r.stdout, /^pass +web\.dev +[\d.]+s +npm run dev -- --port \{port:web\}$/m);
  untouched(p);
});

test("prove reports a failing check or dev command with its output and exits 1; the fix is set in the proposal, and naming one proves it again alone", () => {
  const api = { name: "@shop/api", scripts: { "start:dev": script("process.exit(3)"), test: script("console.log('expected 2, got 3'); process.exit(1)") }, dependencies: { "@nestjs/core": "10.0.0" } };
  const p = shop({ files: { ...SHOP, "apps/api/package.json": json(api) } });
  const f = fakes();
  const d = detect(p, f);
  let r = run(p, f, ["prove"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^fail +api\.test .*\n(  .*\n)*  expected 2, got 3$/m);
  assert.match(r.stdout, /^fail +api\.dev .*\n(  .*\n)*  exited 3/m);
  let { proof } = proposal(d);
  assert.deepEqual([proof["api.test"].status, proof["api.dev"].status, proof["web.test"].status], ["fail", "fail", "pass"]);

  // the human's fixes: a corrected check, given on stdin so no shell parses it, and the dev command dropped
  r = run(p, f, ["set", "apps.api.checks.test"], `${script("0")}\n`);
  assert.equal(r.status, 0, r.stderr);
  for (const field of ["apps.api.dev", "apps.api.health"]) {
    r = run(p, f, ["set", field, "null"]);
    assert.equal(r.status, 0, r.stderr);
  }
  r = run(p, f, ["prove", "api.test"]);
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(r.stdout.trim().split("\n").map((l) => l.split(/ +/).slice(0, 2).join(" ")), ["pass api.test"]);
  ({ proof } = proposal(d));
  assert.deepEqual([proof["api.test"].status, proof["api.test"].cmd], ["pass", script("0")]);
  r = run(p, f, ["apply"]);
  assert.equal(r.status, 0, r.stderr);
  const written = JSON.parse(read(p, ".factory/setup.json")).apps.find((a) => a.name === "api");
  assert.deepEqual([written.checks.test, written.dev, written.health], [script("0"), undefined, undefined]);
});

test("prove stops every dev server it started, both when it finishes and when it's killed", async () => {
  const tmp = scratch("factory-prove-"), pidFile = path.join(tmp, "web.pid");
  const server = `require("node:fs").writeFileSync(require("node:path").join(process.env.TMPDIR, "web.pid"), String(process.pid));\n${SHOP["apps/web/server.js"]}`;
  const p = shop({ files: { ...SHOP, "apps/web/server.js": server } });
  const f = fakes(), env = { ...f.env, TMPDIR: tmp };
  detect(p, f);
  const gone = async (pid) => { for (let n = 0; n < 30 && (() => { try { return process.kill(pid, 0); } catch { return false; } })(); n++) await sleep(100); };
  const alive = (pid) => { try { return process.kill(pid, 0); } catch { return false; } };
  const r = spawnSync(process.execPath, [SCRIPT, "prove"], { cwd: p.dir, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout);
  let pid = Number(fs.readFileSync(pidFile, "utf8"));
  await gone(pid);
  assert.ok(!alive(pid), "the web server is stopped after the proof");

  // a check that needs the apps hangs, and prove is killed while the server is up
  fs.rmSync(pidFile);
  assert.equal(run(p, f, ["set", "apps.web.checks.e2e", script("setTimeout(() => {}, 60000)")]).status, 0);
  const child = spawn(process.execPath, [SCRIPT, "prove", "web.e2e"], { cwd: p.dir, env, stdio: "ignore" });
  while (!fs.existsSync(pidFile)) await sleep(100);
  await sleep(500);
  child.kill("SIGTERM");
  await once(child, "exit");
  pid = Number(fs.readFileSync(pidFile, "utf8"));
  await gone(pid);
  assert.ok(!alive(pid), "the web server is stopped when prove is killed");
});

// every file in the project outside .git, with its content and mtime
const tree = (p) => Object.fromEntries(fs.readdirSync(p.dir, { recursive: true }).filter((f) => !f.startsWith(".git/") && f !== ".git")
  .map((f) => path.join(p.dir, f)).filter((f) => fs.statSync(f).isFile())
  .map((f) => [path.relative(p.dir, f), [fs.readFileSync(f, "utf8"), fs.statSync(f).mtimeMs]]));
const setUp = (p, f, args = []) => {
  const d = detect(p, f, args);
  const r = run(p, f, ["prove"]);
  assert.equal(r.status, 0, r.stdout);
  return d;
};
const apply = (p, f, args = []) => {
  const r = run(p, f, ["apply", ...args]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.stdout;
};

test("apply --dry-run is the proposal: a table of every detected value with its source and marked guesses, and each file's diff; it writes nothing", () => {
  const p = shop({ develop: true });
  const f = fakes({ deployments: [{ environment: "Preview" }] });
  setUp(p, f);
  const out = apply(p, f, ["--dry-run", "--tracker", "github"]);
  assert.match(out, /^\| `apps\.web\.type` \| `web` \| apps\/web\/next\.config\.mjs \|$/m);
  assert.match(out, /^\| `apps\.web\.dev` \| `npm run dev -- --port \{port:web\}` \| apps\/web\/package\.json scripts\.dev, the framework's --port flag \|$/m);
  assert.match(out, /^\| `preview\.web` \| `\{"mode":"github-deployment","environment":"Preview"\}` \| .* \(guess\) \|$/m);
  assert.match(out, /^\| `tracker` \| `github` \|/m);
  for (const f of [".factory/config.json", ".factory/setup.json", ".factory/touch-rules.json", ".factory/index.md", ".factory/log.md", ".factory/lessons.md", ".gitignore", "CLAUDE.md"]) {
    assert.match(out, new RegExp(`^\\+\\+\\+ b/${f.replace(/\./g, "\\.")}$`, "m"), `the diff of ${f}`);
  }
  assert.match(out, /^\+  "tracker": "github",$/m);
  untouched(p);
});

test("apply refuses a recipe command that wasn't proven, writing nothing", () => {
  const p = shop();
  const f = fakes();
  detect(p, f);
  const r = run(p, f, ["apply"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not proven.*web\.test/s);
  untouched(p);
});

test("apply writes .factory/, the gitignore entries and the CLAUDE.md block, nothing under .claude/, then the closing notes; applying twice changes nothing", () => {
  const p = shop({ files: { ...SHOP, "CLAUDE.md": "# Shop\n\nHouse rules.\n" } });
  const f = fakes({ gitleaks: [] });
  setUp(p, f);
  const out = apply(p, f);
  const config = JSON.parse(read(p, ".factory/config.json"));
  assert.deepEqual([config.tracker, config.merge, config.merge_limits, config.parallel_tickets, config.notify], ["github", "trial", { max_files: 40 }, 2, {}]);
  assert.deepEqual([config.models.builder_check, config.models.qa, config.models.retro, config.models.pr], ["sonnet", "sonnet", "sonnet", undefined]);
  assert.deepEqual([config.caps.dispatches_per_run, config.caps.tokens_post_pr, config.qa.drivers], [30, 400000, { web: "playwright-lib", mobile: "maestro" }]);
  assert.deepEqual([config.security, config.branching.model, config.merge_method], [["gitleaks", "audit"], "trunk", "squash"]);
  const recipe = JSON.parse(read(p, ".factory/setup.json"));
  assert.deepEqual(recipe.apps.map((a) => [a.name, a.type]), [["api", "backend"], ["web", "web"], ["ui", "other"]]);
  assert.deepEqual(Object.keys(recipe.budgets.web).sort(), ["dev", "e2e", "lint", "test", "typecheck"]);
  assert.equal(typeof recipe.budgets.api.dev, "number");
  const rules = JSON.parse(read(p, ".factory/touch-rules.json"));
  assert.ok(rules.auth && rules.ui && !rules.analytics);
  assert.match(read(p, ".factory/index.md"), /^- `web` \(web\): `apps\/web`$/m);
  assert.ok(fs.existsSync(path.join(p.dir, ".factory/log.md")) && fs.existsSync(path.join(p.dir, ".factory/lessons.md")));
  assert.deepEqual(read(p, ".gitignore").split("\n").filter(Boolean), [".factory/runs/", ".factory/worktrees/", ".factory/env.local"]);
  const claude = read(p, "CLAUDE.md");
  assert.ok(claude.startsWith("# Shop\n\nHouse rules.\n\n<!-- factory:begin -->\n"), claude);
  assert.match(claude, /`\.factory\/index\.md`/);
  assert.match(claude, /^- In `apps\/api`: `npm run test:integration`\.$/m, "a script not named for its check");
  assert.doesNotMatch(claude, /apps\/web/, "`npm run <check>` goes without saying");
  assert.match(claude, /`\/factory/);
  assert.ok(claude.endsWith("<!-- factory:end -->\n"));
  assert.ok(!fs.existsSync(path.join(p.dir, ".claude")), "nothing under .claude/");
  assert.ok(!fs.existsSync(path.join(p.dir, ".mcp.json")), "no MCP server registered");
  assert.match(out, /Include your own updates/);
  assert.match(out, /is:open is:pr label:factory label:needs-human/);
  assert.match(out, /osv-scanner isn't installed.*brew install osv-scanner/);
  assert.match(out, /semgrep isn't installed.*brew install semgrep/);
  assert.doesNotMatch(out, /gitleaks isn't installed|develop/);

  const before = tree(p);
  assert.match(apply(p, f), /nothing to write/);
  assert.deepEqual(tree(p), before, "the same proposal applied again");
  setUp(p, f);
  apply(p, f);
  assert.deepEqual(tree(p), before, "a re-run with nothing new");
});

const write = (p, f, body) => {
  fs.mkdirSync(path.dirname(path.join(p.dir, f)), { recursive: true });
  fs.writeFileSync(path.join(p.dir, f), typeof body === "string" ? body : json(body));
};

test("a re-run takes the kept values as defaults, fills only what's missing and flags each disagreement", () => {
  const p = shop();
  const f = fakes();
  setUp(p, f);
  apply(p, f, ["--tracker", "local"]);
  // the human's edits (a check changed, the API's dev command dropped), and an app added since
  const KEPT = script("1 + 1 // $' $& $$");  // replacement patterns, which must reach CLAUDE.md as written
  const recipe = JSON.parse(read(p, ".factory/setup.json"));
  const kept = recipe.apps.find((a) => a.name === "api");
  kept.checks.test = KEPT;
  delete kept.dev;
  delete kept.health;
  write(p, ".factory/setup.json", recipe);
  const config = JSON.parse(read(p, ".factory/config.json"));
  config.caps.dispatches_per_run = 40;
  write(p, ".factory/config.json", config);
  write(p, "packages/admin/package.json", { name: "@shop/admin", scripts: { lint: script("0") }, dependencies: { next: "15.0.0" }, devDependencies: { "@playwright/test": "1", "@axe-core/playwright": "4" } });
  write(p, "packages/admin/next.config.js", "module.exports = {};\n");
  const index = read(p, ".factory/index.md");

  const d = setUp(p, f, ["--mcp", "linear"]);
  assert.equal(d.tracker, "local", "the kept tracker leads, though Linear's MCP is visible");
  assert.deepEqual(d.disagreements, [
    { field: "apps.api.dev", kept: null, detected: "PORT={port:api} npm run start:dev" },
    { field: "apps.api.health", kept: null, detected: "http://localhost:{port:api}/" },
    { field: "apps.api.checks.test", kept: KEPT, detected: "npm run test" },
  ], "a dropped command stays dropped, and a plugin default is never a disagreement");
  const out = apply(p, f, ["--dry-run"]);
  assert.match(out, /^- `apps\.api\.dev`: kept none, detected `"PORT=\{port:api\} npm run start:dev"`$/m);
  assert.ok(out.includes(`- \`apps.api.checks.test\`: kept \`${JSON.stringify(KEPT)}\`, detected \`"npm run test"\`\n`), out);
  apply(p, f);
  const after = JSON.parse(read(p, ".factory/setup.json"));
  assert.deepEqual(after.apps.map((a) => a.name), ["api", "web", "ui", "admin"]);
  assert.deepEqual([after.apps[0].checks.test, after.apps[0].dev], [KEPT, undefined]);
  assert.ok(read(p, "CLAUDE.md").includes(`- In \`apps/api\`: \`${KEPT}\`, \`npm run test:integration\`.\n`), read(p, "CLAUDE.md"));
  assert.deepEqual(after.pinned, ["apps/api/e2e", "apps/web/tests/e2e", "packages/admin/e2e"], "the new app's directory joins the kept list");
  assert.deepEqual([JSON.parse(read(p, ".factory/config.json")).caps.dispatches_per_run, JSON.parse(read(p, ".factory/config.json")).tracker], [40, "local"]);
  assert.equal(read(p, ".factory/index.md"), index, "a memory file is never rewritten");
});

test("apply adds @playwright/test and @axe-core/playwright as dev dependencies, with Chromium, to a web app lacking them", () => {
  const site = { "package.json": json({ name: "site", scripts: { test: "vitest run" }, dependencies: { next: "15.0.0" } }), "pnpm-lock.yaml": "lockfileVersion: '9.0'\n", "next.config.js": "module.exports = {};\n" };
  const p = shop({ files: site });
  const f = fakes({ pnpm: [{ match: /./, file: EMPTY }] });
  const d = setUp(p, f);
  const commands = [["pnpm", "add", "-D", "@playwright/test", "@axe-core/playwright"], ["pnpm", "exec", "playwright", "install", "chromium"]];
  assert.deepEqual(d.installs, [{ app: "site", path: ".", commands }]);
  assert.match(apply(p, f, ["--dry-run"]), /## Installs\n\n- In `\.`: `pnpm add -D @playwright\/test @axe-core\/playwright`, then `pnpm exec playwright install chromium`/);
  apply(p, f);
  assert.deepEqual(f.calls("pnpm"), [["run", "test"], ...commands.map(([, ...rest]) => rest)]);
  assert.doesNotMatch(read(p, "CLAUDE.md"), /At the root/, "`pnpm run test` at the root goes without saying");

  const has = shop({ files: { ...site, "package.json": json({ name: "site", scripts: { test: "vitest run" }, dependencies: { next: "15.0.0" }, devDependencies: { "@playwright/test": "1", "@axe-core/playwright": "4" } }) } });
  const g = fakes({ pnpm: [{ match: /./, file: EMPTY }] });
  assert.deepEqual(setUp(has, g).installs, []);
  apply(has, g);
  assert.deepEqual(g.calls("pnpm"), [["run", "test"]]);
});
