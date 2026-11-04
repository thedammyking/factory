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

test("no GitHub remote or a failing gh auth status stops setup with the fix, writing nothing", () => {
  const noRemote = shop({ remote: null });
  let r = run(noRemote, fakes(), ["detect"]);
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

test("section B: a Notion parent page's URL sends specs to Notion under that page's ID, and null keeps them in the repo", () => {
  const p = shop();
  const f = fakes();
  detect(p, f);
  const unseen = run(p, f, ["set", "notion_parent", "0123456789abcdef0123456789abcdef"]);
  assert.equal(unseen.status, 2, "section B is only for a session that sees a Notion MCP");
  assert.match(unseen.stderr, /no Notion MCP/);
  detect(p, f, ["--mcp", "notion"]);
  const config = () => proposal({ file: path.join(p.dir, ".git/factory-setup.json") }).config;
  assert.equal(config().docs, "repo", "the default, before the answer");
  const bad = run(p, f, ["set", "notion_parent", "https://example.com/specs"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /names no Notion page/);
  const r = run(p, f, ["set", "notion_parent", "https://www.notion.so/acme/Specs-0123456789ABCDEF0123456789abcdef?pvs=4"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([config().docs, config().notion_parent], ["notion", "01234567-89ab-cdef-0123-456789abcdef"]);
  const diff = run(p, f, ["apply", "--dry-run"]).stdout;
  assert.match(diff, /^\+  "docs": "notion",$/m);
  assert.match(diff, /^\+  "notion_parent": "01234567-89ab-cdef-0123-456789abcdef"$/m);
  assert.equal(run(p, f, ["set", "notion_parent", "null"]).status, 0);
  assert.deepEqual([config().docs, "notion_parent" in config()], ["repo", false]);
});

test("section B: a fresh config grills one question at a time, and set grill takes only one or all", () => {
  const p = shop();
  const f = fakes();
  detect(p, f);
  assert.match(run(p, f, ["apply", "--dry-run"]).stdout, /^\+  "grill": "one",$/m);
  for (const value of ["both", "One", "null", '"one "']) {
    const r = run(p, f, ["set", "grill", value]);
    assert.equal(r.status, 2, `set grill ${value}`);
    assert.match(r.stderr, /grill is one or all/);
  }
  const r = run(p, f, ["set", "grill", "all"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(run(p, f, ["apply", "--dry-run"]).stdout, /^\+  "grill": "all",$/m);
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

test("section A: `other` writes the run operations the human described into .factory/tracker.md, and is refused without them", () => {
  const p = shop();
  const f = fakes();
  setUp(p, f);
  const bare = run(p, f, ["apply", "--tracker", "other"]);
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /describe the tracker first: setup-factory\.mjs set tracker_doc/);
  untouched(p);
  const ops = "- **Read a reference**: `PROJ-12`; `jira issue view PROJ-12 --plain`, its summary and description.\n- **Comment**: `jira issue comment add PROJ-12 \"<the text>\"`.\n";
  assert.equal(run(p, f, ["set", "tracker_doc"], ops).status, 0);
  apply(p, f, ["--tracker", "other"]);
  assert.equal(JSON.parse(read(p, ".factory/config.json")).tracker, "other");
  const doc = read(p, ".factory/tracker.md");
  assert.match(doc, /^# Tracker\n/);
  assert.ok(doc.endsWith(`## Run operations\n\n${ops}`), doc);
  setUp(p, f);
  assert.match(apply(p, f, ["--tracker", "other"]), /nothing to write/, "a re-run keeps the described tracker");
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

test("apply records the package manager in the recipe, and a re-run keeps it and leads with it, though a lockfile now names another", () => {
  const p = shop({ files: { "package.json": json({ name: "lib", scripts: { test: script("0") } }) } });
  const f = fakes();
  setUp(p, f);
  apply(p, f);
  assert.equal(JSON.parse(read(p, ".factory/setup.json")).package_manager, "npm");
  const before = tree(p);
  write(p, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  const d = setUp(p, f);
  assert.deepEqual([d.package_manager, source(d, "package_manager").source, d.disagreements], ["npm", ".factory/setup.json", []]);
  assert.match(apply(p, f), /nothing to write/);
  assert.deepEqual(tree(p), { ...before, "pnpm-lock.yaml": tree(p)["pnpm-lock.yaml"] }, "the recipe, CLAUDE.md and the rest as they were");
});

test("a repo with no package.json gets `pnpm init` in the proposal, run once by apply before anything is written, and a recipe with no apps", () => {
  const p = shop({ files: { "README.md": "hi\n" } });
  const f = fakes({ pnpm: [{ match: /^init$/, file: EMPTY }] }), noPnpm = fakes();
  const d = detect(p, f);
  assert.deepEqual([d.package_manager, d.recipe.package_manager, d.recipe.apps], ["pnpm", "pnpm", []]);
  assert.match(apply(p, f, ["--dry-run"]), /^\| `package_manager` \| `pnpm` \| no package\.json, so apply runs `pnpm init` first/m);
  assert.deepEqual(f.calls("pnpm"), [], "nothing runs before the proposal is approved");
  untouched(p);

  const missing = run(p, noPnpm, ["apply"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /corepack enable pnpm/);
  untouched(p);

  const out = apply(p, f);
  assert.deepEqual(f.calls("pnpm"), [["init"]]);
  assert.match(out, /^ran pnpm init\nwrote \.factory\/config\.json$/m, "before anything is written");
  assert.match(out, /^- The recipe has no apps yet: the first run's scaffold ticket fills it\.$/m);
  const recipe = JSON.parse(read(p, ".factory/setup.json"));
  assert.deepEqual([recipe.apps, recipe.package_manager], [[], "pnpm"]);
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

// The developer's env files: the web app's .env.example with its purposes, the API's names from its .env* files alone.
// Every value is fake, and SECRETS lists each one that must never reach stdout or the proposal.
const ENV = {
  "apps/web/.env.example": "# Where the browser reaches the API\nNEXT_PUBLIC_API_URL=\nNEXTAUTH_URL=http://localhost:3000\n\n# Stripe's secret key, in test mode\nSTRIPE_SECRET_KEY=\nSTRIPE_PUBLISHABLE_KEY=\n# DEBUG=1\nSENTRY_DSN=\n",
  "apps/web/.env.local": "NEXT_PUBLIC_API_URL=http://localhost:4000/v1\nNEXTAUTH_URL=http://localhost:3000\nSTRIPE_SECRET_KEY=sk_live_fakeSecret1\nSTRIPE_PUBLISHABLE_KEY=pk_live_fakePub2\nLOCAL_ONLY=fake-local-only\n",
  "apps/web/.env.development": "STRIPE_PUBLISHABLE_KEY=pk_test_fakePub3\n",
  "apps/api/.env.local": "DATABASE_URL=postgres://shop:fake-pw-local@localhost:5432/shop_dev\n",
  "apps/api/.env.development": "DATABASE_URL=postgres://shop:fake-pw-dev@db.dev.internal/shop\nREDIS_URL=\"redis://:fake-redis-dev@cache.dev.internal:6379\"\n",
  "apps/api/.env": "# was postgres://admin:fake-pw-old@prod-db/shop\nDATABASE_URL=postgres://shop:fake-pw-env@db.internal/shop\nREDIS_URL=redis://:fake-redis-env@cache.internal:6379\nPORT=4000\nexport JWT_SECRET=fake-jwt-env # signs sessions\n",
};
const SECRETS = ["/v1", "sk_live_fakeSecret1", "pk_live_fakePub2", "pk_test_fakePub3", "fake-local-only", "fake-pw-old", "fake-pw-local", "fake-pw-dev", "fake-pw-env",
  "shop_dev", "fake-redis-dev", "fake-redis-env", "fake-jwt-env", "fake-jwt-human", "sk_test_fakeHuman5"];
const noValue = (text, where) => { for (const s of SECRETS) assert.ok(!text.includes(s), `${where} holds the value ${s}`); };

test("detect names each variable from its directory's .env.example, else from its other .env* files, with the example's comment as its purpose, and never a value", () => {
  const p = shop({ files: { ...SHOP, ...ENV } });
  const r = run(p, fakes(), ["detect"]);
  assert.equal(r.status, 0, r.stderr);
  const d = JSON.parse(r.stdout);
  assert.deepEqual(d.recipe.env, {
    DATABASE_URL: null, REDIS_URL: null, PORT: null, JWT_SECRET: null,
    NEXT_PUBLIC_API_URL: "Where the browser reaches the API", NEXTAUTH_URL: null,
    STRIPE_SECRET_KEY: "Stripe's secret key, in test mode", STRIPE_PUBLISHABLE_KEY: null, SENTRY_DSN: null,
  }, "LOCAL_ONLY isn't in the web app's example; a commented-out line is no purpose, nor is a comment in the developer's own file");
  assert.deepEqual(source(d, "env.NEXT_PUBLIC_API_URL"), { field: "env.NEXT_PUBLIC_API_URL", value: "Where the browser reaches the API", source: "apps/web/.env.example", guess: false });
  assert.equal(source(d, "env.JWT_SECRET").source, "apps/api/.env");
  noValue(r.stdout, "detect's stdout");
  noValue(fs.readFileSync(d.file, "utf8"), "the proposal");
});

// .factory/env.local's NAME=value lines, as written
const envLocal = (p) => Object.fromEntries(read(p, ".factory/env.local").split("\n").flatMap((l) => { const m = l.match(/^(\w+)=(.*)$/); return m ? [[m[1], m[2]]] : []; }));

test("env copies each named variable from .env.local, then .env.development, then .env, a loopback URL at an app's port as {port:<app>} and a live value not at all, printing names and hosts only", () => {
  const p = shop({ files: { ...SHOP, ...ENV } });
  const f = fakes();
  const d = detect(p, f);
  const r = run(p, f, ["env"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(envLocal(p), {
    DATABASE_URL: "postgres://shop:fake-pw-local@localhost:5432/shop_dev",
    REDIS_URL: '"redis://:fake-redis-dev@cache.dev.internal:6379"',
    PORT: "{port:api}",
    JWT_SECRET: "fake-jwt-env # signs sessions",
    NEXT_PUBLIC_API_URL: "http://localhost:{port:api}/v1",
    NEXTAUTH_URL: "http://localhost:{port:web}",
    STRIPE_PUBLISHABLE_KEY: "pk_test_fakePub3",
  }, ".env.local first, then .env.development, then .env; the API at its PORT and web at Next.js's 3000 follow their apps; 5432 is no app's");
  const text = read(p, ".factory/env.local");
  assert.match(text, /^# Not copied: /m);
  assert.match(text, /^# STRIPE_SECRET_KEY=$/m, "only a live value exists, so it's a gap");
  assert.match(text, /^# SENTRY_DSN=$/m, "no file has a value");
  assert.doesNotMatch(text, /LOCAL_ONLY|_live_/);
  assert.equal(fs.statSync(path.join(p.dir, ".factory/env.local")).mode & 0o777, 0o600);
  assert.equal(p.git("status", "--porcelain"), "", "before apply writes the .gitignore, git already ignores env.local");

  assert.match(r.stdout, /^copied +DATABASE_URL +from apps\/api\/\.env\.local, host localhost$/m);
  assert.match(r.stdout, /^copied +REDIS_URL +from apps\/api\/\.env\.development, host cache\.dev\.internal$/m);
  assert.match(r.stdout, /^copied +JWT_SECRET +from apps\/api\/\.env$/m);
  assert.match(r.stdout, /^copied +NEXT_PUBLIC_API_URL +from apps\/web\/\.env\.local, host localhost, at \{port:api\}$/m);
  assert.match(r.stdout, /^gap +STRIPE_SECRET_KEY +a live value in apps\/web\/\.env\.local isn't copied$/m);
  assert.match(r.stdout, /^gap +SENTRY_DSN +no value in \.env\.local, \.env\.development or \.env$/m);
  noValue(r.stdout, "env's stdout");
  noValue(fs.readFileSync(d.file, "utf8"), "the proposal");
});

test("prove, after env, runs every command with .factory/env.local's values and nothing from the developer's shell, each {port:<app>} at its app's port", () => {
  const dump = path.join(scratch("factory-env-"), "env.json");
  const web = JSON.parse(SHOP["apps/web/package.json"]);
  web.scripts.e2e = script("fetch(process.env.NEXT_PUBLIC_API_URL).then((r) => process.exit(r.status === 404 ? 0 : 1), () => process.exit(1))");
  const p = shop({ files: { ...SHOP, ...ENV, "apps/web/package.json": json(web) } });
  const f = fakes();
  detect(p, f);
  assert.equal(run(p, f, ["env"]).status, 0);
  // a check that records what it sees, run straight from bash
  assert.equal(run(p, f, ["set", "apps.web.checks.test"], script(`require("fs").writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env))`)).status, 0);
  const shell = { ...f.env, DEV_SHELL_ONLY: "fake-shell-only", DATABASE_URL: "fake-shell-db" };
  const r = spawnSync(process.execPath, [SCRIPT, "prove"], { cwd: p.dir, encoding: "utf8", env: shell });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^pass +web\.e2e /m, "the API answered at the URL env.local gave the web app");
  const seen = JSON.parse(fs.readFileSync(dump, "utf8"));
  const { PWD, SHLVL, _, __CF_USER_TEXT_ENCODING, ...rest } = seen;  // bash's own, and the one macOS sets in every process
  assert.deepEqual(Object.keys(rest).sort(), ["DATABASE_URL", "HOME", "JWT_SECRET", "NEXTAUTH_URL", "NEXT_PUBLIC_API_URL", "PATH", "PORT", "REDIS_URL", "STRIPE_PUBLISHABLE_KEY", "TMPDIR"]);
  assert.deepEqual([seen.DATABASE_URL, seen.REDIS_URL, seen.JWT_SECRET, seen.PATH], ["postgres://shop:fake-pw-local@localhost:5432/shop_dev", "redis://:fake-redis-dev@cache.dev.internal:6379", "fake-jwt-env", f.env.PATH]);
  assert.match(seen.NEXT_PUBLIC_API_URL, /^http:\/\/localhost:\d+\/v1$/);
  assert.doesNotMatch(seen.NEXT_PUBLIC_API_URL, /:4000\//, "a free port, not the developer's");
  assert.equal(seen.NEXT_PUBLIC_API_URL, `http://localhost:${seen.PORT}/v1`, "the API's PORT is the same port");
  noValue(r.stdout, "prove's stdout");

  // a failing check that prints a value shows its name instead
  assert.equal(run(p, f, ["set", "apps.api.checks.test"], script("console.log('cannot reach', process.env.DATABASE_URL); process.exit(1)")).status, 0);
  const failed = run(p, f, ["prove", "api.test"]);
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /^  cannot reach \{env:DATABASE_URL\}$/m);
  noValue(failed.stdout, "a failing check's output");
});

test("env again keeps every line the human wrote in env.local and adds only new names; a variable left out makes the checks needing it skipped", () => {
  const p = shop({ files: { ...SHOP, ...ENV } });
  const f = fakes();
  detect(p, f);
  run(p, f, ["env"]);
  // the human's edits: a test key in a gap, a value changed and one of their own; SENTRY_DSN isn't available
  const text = read(p, ".factory/env.local").replace("# STRIPE_SECRET_KEY=", "STRIPE_SECRET_KEY=sk_test_fakeHuman5")
    .replace(/^JWT_SECRET=.*$/m, "JWT_SECRET=fake-jwt-human") + "COREPACK_ENABLE_AUTO_PIN=0\n";
  write(p, ".factory/env.local", text);
  // a variable the project has named since
  fs.appendFileSync(path.join(p.dir, "apps/web/.env.example"), "FEATURE_FLAGS=\n");
  fs.appendFileSync(path.join(p.dir, "apps/web/.env.local"), "FEATURE_FLAGS=fake-flags\n");
  detect(p, f);
  const r = run(p, f, ["env"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(p, ".factory/env.local"), `${text}FEATURE_FLAGS=fake-flags\n`);
  assert.match(r.stdout, /^kept +STRIPE_SECRET_KEY +in \.factory\/env\.local$/m);
  assert.match(r.stdout, /^kept +NEXT_PUBLIC_API_URL +in \.factory\/env\.local, host localhost, at \{port:api\}$/m);
  assert.match(r.stdout, /^copied +FEATURE_FLAGS +from apps\/web\/\.env\.local$/m);
  assert.match(r.stdout, /^gap +SENTRY_DSN +no value in /m);
  assert.doesNotMatch(r.stdout, /COREPACK/, "only the recipe's names are listed");
  noValue(r.stdout, "env's stdout");

  // the proof shows the web app's e2e check needs SENTRY_DSN; the human gives it a purpose
  const e2e = { cmd: "npm run e2e", env: ["SENTRY_DSN"] };
  assert.equal(run(p, f, ["set", "apps.web.checks.e2e", JSON.stringify(e2e)]).status, 0);
  assert.equal(run(p, f, ["set", "env.SENTRY_DSN", "Where errors are reported"]).status, 0);
  const proved = run(p, f, ["prove"]);
  assert.equal(proved.status, 0, proved.stdout);
  assert.match(proved.stdout, /^skipped +web\.e2e +0s +npm run e2e\n  SENTRY_DSN not available in \.factory\/env\.local$/m);
  apply(p, f);
  const recipe = JSON.parse(read(p, ".factory/setup.json"));
  assert.deepEqual(recipe.apps.find((a) => a.name === "web").checks.e2e, e2e);
  assert.equal(recipe.env.SENTRY_DSN, "Where errors are reported");
  assert.deepEqual(Object.keys(recipe.budgets.web).sort(), ["dev", "lint", "test", "typecheck"], "a skipped check has no budget");
  assert.doesNotMatch(read(p, "CLAUDE.md"), /\[object Object\]/);
  noValue(read(p, ".factory/setup.json"), "the recipe");

  // once the human fills it in, the skipped check is no longer proven
  fs.appendFileSync(path.join(p.dir, ".factory/env.local"), "SENTRY_DSN=https://fake-dsn@sentry.example/1\n");
  const r2 = run(p, f, ["apply"]);
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /not proven: web\.e2e/);
  assert.match(run(p, f, ["prove", "web.e2e"]).stdout, /^pass +web\.e2e /m);
  apply(p, f);
});

test("the proposal lists what env.local sets by name, a URL by its host, and what isn't available; never a value", () => {
  const p = shop({ files: { ...SHOP, ...ENV } });
  const f = fakes();
  detect(p, f);
  run(p, f, ["env"]);
  assert.equal(run(p, f, ["prove"]).status, 0);
  const out = apply(p, f, ["--dry-run"]);
  assert.match(out, /^## Environment\n\n`\.factory\/env\.local` sets, values never shown:\n/m);
  assert.match(out, /^- `REDIS_URL`: host cache\.dev\.internal$/m);
  assert.match(out, /^- `NEXT_PUBLIC_API_URL`: host localhost, at \{port:api\}$/m);
  assert.match(out, /^- `JWT_SECRET`$/m);
  assert.match(out, /^Not available, so the checks needing them are skipped: `STRIPE_SECRET_KEY`, `SENTRY_DSN`\.$/m);
  assert.match(out, /^\| `env\.STRIPE_SECRET_KEY` \| `Stripe's secret key, in test mode` \| apps\/web\/\.env\.example \|$/m);
  noValue(out, "the proposal");
});

const STARTER = fs.readFileSync(path.resolve(path.dirname(SCRIPT), "../templates/semgrep/starter.yaml"), "utf8");
// A fake semgrep finding `tree` in the project's tree and `planted` in the planted file.
const semgrep = (tree, planted) => ({ semgrep: [
  { match: /factory-planted-/, file: canned(`planted-${Math.random()}`, { results: planted, errors: [] }) },
  { match: /^scan /, file: canned(`tree-${Math.random()}`, { results: tree, errors: [] }) },
] });
const HIT = { check_id: "factory.semgrep.factory-mass-assignment", path: "src/users.ts", start: { line: 3 } };

test("with semgrep installed, prove runs the starter rules over the project's tree and a planted file, and apply writes them to .factory/semgrep/", () => {
  const p = shop();
  const f = fakes(semgrep([], [HIT]));
  const d = setUp(p, f);
  assert.deepEqual(d.config.security, ["audit", "semgrep"]);
  const proof = proposal(d).proof.semgrep;
  assert.deepEqual([proof.status, proof.cmd], ["pass", "semgrep --config .factory/semgrep/project.yaml"]);
  const calls = f.calls("semgrep");
  assert.deepEqual(calls.map((c) => path.basename(c.at(-1))), [".", "planted.ts"], "the project's tree, then the planted file");
  for (const c of calls) assert.ok(c.includes("--metrics=off") && c[c.indexOf("--config") + 1].endsWith("templates/semgrep/starter.yaml"), c.join(" "));
  assert.match(apply(p, f, ["--dry-run"]), /^\+\+\+ b\/\.factory\/semgrep\/project\.yaml$/m);
  apply(p, f);
  assert.equal(read(p, ".factory/semgrep/project.yaml"), STARTER);
  assert.doesNotMatch(STARTER, /track\(/, "no analytics rule");
  write(p, ".factory/semgrep/project.yaml", `${STARTER}  - id: from-a-retro\n`);
  setUp(p, f);
  assert.match(apply(p, f), /nothing to write/, "kept rules are never rewritten");
});

test("a starter rule that fires on the project's tree, or none on the planted file, fails the proof, and apply refuses", () => {
  const p = shop();
  let f = fakes(semgrep([HIT], [HIT]));
  detect(p, f);
  let r = run(p, f, ["prove", "semgrep"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^fail +semgrep .*\n  factory-mass-assignment src\/users\.ts:3$/m);
  r = run(p, f, ["apply"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not proven: .*semgrep \(`semgrep --config \.factory\/semgrep\/project\.yaml`\)/);

  f = fakes(semgrep([], []));
  r = run(p, f, ["prove", "semgrep"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^fail +semgrep .*\n  nothing found in the planted file$/m);
  untouched(p);
});

// semgrep on its own in a directory of its own, so no other installed tool reaches detection
const realSemgrep = process.env.PATH.split(path.delimiter).map((d) => path.join(d, "semgrep")).find((f) => fs.existsSync(f));
test("the real semgrep proves the starter rules on a project", { skip: !realSemgrep && "semgrep isn't installed" }, () => {
  const p = shop();
  const f = fakes(), only = scratch("factory-semgrep-");
  fs.symlinkSync(realSemgrep, path.join(only, "semgrep"));
  f.env.PATH = [only, f.env.PATH].join(path.delimiter);
  detect(p, f);
  const r = run(p, f, ["prove", "semgrep"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^pass +semgrep /m);
});
