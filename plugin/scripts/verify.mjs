#!/usr/bin/env node
// verify.mjs --fast | --full | --pinned <path> — runs every check in the run worktree's recipe (.factory/setup.json) for
// every app, never stopping at the first failure, and writes the evidence to the run dir: evidence.json for --full,
// evidence-fast.json for --fast (typecheck, lint and test only), so a fast pass never stands in for a full one. Takes
// --run <id>, or derives the run from the run worktree it runs in. Run in a ticket's worktree, it checks that worktree
// instead, and writes to tickets/<NN>/ in the run dir.
//   - --full also runs each pinned test: a file qa named <run>-<NN>-<slug>.test.mjs (node:test) or .spec.ts (Playwright,
//     the project's own) in one of the recipe's `pinned` directories. Each is a check of its own, marked pinned, run in
//     the app whose path holds it while the apps are up, with that app's URL as BASE_URL. --pinned <path> runs only that
//     test, in the worktree holding it, wherever it's called from, into evidence-pinned.json.
//   - pinned_only marks a red where every check that didn't pass is pinned, on a clean and trusted tree: qa rules on it.
//   - A check is "<command>" or { cmd, env: [names it needs] }. It runs under bash in its app's path with lib's runEnv,
//     its full output saved to logs/<app>-<check>.log in the run dir (.fast.log or .pinned.log); a failing one carries
//     lib's digest of that output.
//   - A check needing a name .factory/env.local doesn't hold is skipped, never run. An app without a test check fails it.
//   - A check its app lists in needs_apps runs between run-apps up and down, with {port:<app>} and {db} filled in its
//     command and env from apps.json. When up fails the check is skipped with up's output, since apps that won't come
//     up are the environment's. --full runs run-apps down first, so a stack left up never holds a port an e2e suite's
//     own servers need (design fix 15).
//   - The evidence is pinned to HEAD. It's dirty when the tree is unclean outside .factory/ (the recipe included) or HEAD
//     moved, trusted when the recipe equals HEAD's, and green when every check passed and it's clean and trusted.
//   - red_cause says why it isn't green: inherited when every failing check fails at the base commit too (rerun there in
//     a temp worktree after the recipe's setup), introduced when one doesn't, incomplete when nothing failed on a dirty
//     or untrusted tree, and environment when only skips stand in the way.
// Prints a status line and the digest of each check that didn't pass; exits 0 only when green.
import fs from "node:fs";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readJson, arg, git, worktreesDir, runContext, runEnv, digest, fill } from "./lib.mjs";

const mode = ["fast", "full", "pinned"].find((m) => process.argv.includes(`--${m}`));
if (!mode) { console.error("verify: usage: verify.mjs --fast | --full | --pinned <path> [--run <id>]"); process.exit(2); }
const onlyTest = mode === "pinned" && path.resolve(arg("--pinned") ?? "");  // --pinned's file, else false
if (onlyTest && !fs.statSync(onlyTest, { throwIfNoEntry: false })?.isFile()) { console.error(`verify: no pinned test at ${onlyTest}`); process.exit(2); }
if (onlyTest) process.chdir(path.dirname(onlyTest));
const ctx = runContext(), s = readJson(ctx.state), tree = ctx.tree, out = ctx.ticket ? path.join(ctx.runDir, "tickets", ctx.ticket) : ctx.runDir;
const RECIPE = ".factory/setup.json", FAST = ["typecheck", "lint", "test"];
let text, recipe; try { text = fs.readFileSync(path.join(tree, RECIPE), "utf8"); recipe = JSON.parse(text); } catch (e) {
  console.error(`verify: no recipe at ${path.join(tree, RECIPE)} (${e.message})`); process.exit(2);
}
let committed = null; try { committed = git(tree, "show", `HEAD:${RECIPE}`); } catch {}
const trusted = committed === text.trim();
// {base} reaches a command only as a quoted reference to the base branch, never as text spliced into it.
const env = runEnv(ctx.MAIN, { FACTORY_BASE: s.base_branch });
const logs = path.join(out, "logs");
fs.mkdirSync(logs, { recursive: true });
const appDir = (root, name) => path.join(root, recipe.apps.find((a) => a.name === name).path || ".");
const NOT_RUN = { exit: null, seconds: 0, log: null };
const logOf = (name) => path.join(logs, `${name.replace(/[^\w.-]/g, "_")}${mode === "full" ? "" : `.${mode}`}.log`);
const RUN_APPS = fileURLToPath(new URL("run-apps.mjs", import.meta.url));
const apps = (cmd) => spawnSync(process.execPath, [RUN_APPS, cmd, "--run", ctx.id], { encoding: "utf8" });

// Executes one command, its stdout and stderr interleaved into logs/<name>.log.
function execute(cwd, cmd, name, cmdEnv = env) {
  const log = logOf(name);
  const fd = fs.openSync(log, "w"), t0 = Date.now();
  const r = spawnSync("bash", ["-c", cmd.replaceAll("{base}", '"$FACTORY_BASE"')], { cwd, env: cmdEnv, stdio: ["ignore", fd, fd], timeout: 10 * 60_000 });
  if (r.error) fs.writeSync(fd, `\nverify: ${r.error.message}\n`);
  fs.closeSync(fd);
  const status = r.status === 0 ? "pass" : "fail";
  return { status, exit: r.status, seconds: Math.round((Date.now() - t0) / 100) / 10, log,
    digest: status === "fail" ? digest(fs.readFileSync(log, "utf8"), log) : null };
}

// Each failing check's result at the commit the run branched from, the base's merge-base with HEAD, as c.at_base.
// Nothing is recorded when there's no merge-base, its worktree can't be made, or the recipe's setup fails there.
// ponytail: reruns the failing checks at the base on every red, --fast too; cache by base commit if it shows in the minutes.
function atBase(failing) {
  let sha; try { sha = git(tree, "merge-base", "HEAD", `refs/heads/${s.base_branch}`); } catch { return; }
  const wt = fs.mkdtempSync(path.join(worktreesDir(ctx.MAIN), ".at-base-"));
  try { git(ctx.MAIN, "worktree", "add", "-q", "--detach", wt, sha); } catch { fs.rmSync(wt, { recursive: true, force: true }); return; }
  try {
    if (recipe.setup && execute(wt, recipe.setup, "setup.at-base").status === "fail") return;
    for (const c of failing) c.at_base = execute(appDir(wt, c.app), c.cmd, `${c.app}-${c.check}.at-base`);
  } finally { git(ctx.MAIN, "worktree", "remove", "--force", wt); }
}

// Runs a check that needs apps between run-apps up and down. A pinned test gets its path, from its app's, as
// $FACTORY_PINNED, never spliced into the command, and its app's URL as BASE_URL.
function withApps(app, check, cmd, pinnedPath) {
  const up = apps("up");
  try {
    if (up.status !== 0) {
      const log = logOf(`${app}-${check}`), output = `run-apps up failed\n${up.stdout}${up.stderr}`;
      fs.writeFileSync(log, output);
      return { status: "skipped", ...NOT_RUN, log, digest: digest(output, log) };
    }
    const recorded = readJson(path.join(ctx.runDir, "apps.json"));
    const filled = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, typeof v === "string" ? fill(v, recorded) : v]));
    const url = recorded?.apps?.[app]?.url;
    if (pinnedPath) Object.assign(filled, { FACTORY_PINNED: pinnedPath }, url && { BASE_URL: new URL(url).origin });
    return execute(appDir(tree, app), fill(cmd, recorded), `${app}-${check}`, filled);
  } finally { apps("down"); }
}

// Pinned tests by file type, each found by qa's naming in a pinned directory, and the app whose path holds one, deepest first.
const RUNNERS = { ".test.mjs": 'node --test "$FACTORY_PINNED"', ".spec.ts": 'npx --no playwright test "$FACTORY_PINNED"' };
const QA_NAMED = /^[a-z0-9][a-z0-9-]*-\d{2}-[a-z0-9-]+\./;  // <run>-<NN>-<slug>.
const runner = (rel) => Object.entries(RUNNERS).find(([ext]) => rel.endsWith(ext))?.[1];
const pinnedDirs = [].concat(recipe.pinned ?? []).map((d) => path.normalize(String(d)).replace(/\/+$/, ""));
const holder = (rel) => (recipe.apps || []).map((a) => [a, path.normalize(a.path || ".")])
  .filter(([, p]) => p === "." || rel.startsWith(p + path.sep)).sort(([, a], [, b]) => b.length - a.length)[0]?.[0];
const pinnedTests = onlyTest ? [path.relative(tree, fs.realpathSync(onlyTest))] : mode === "fast" ? [] : pinnedDirs.flatMap((d) => fs.existsSync(path.join(tree, d))
  ? fs.readdirSync(path.join(tree, d)).filter((f) => QA_NAMED.test(f) && runner(f)).sort().map((f) => path.join(d, f)) : []);
if (onlyTest && !(pinnedDirs.some((d) => pinnedTests[0].startsWith(d + path.sep)) && runner(pinnedTests[0]) && holder(pinnedTests[0]))) {
  console.error(`verify: ${pinnedTests[0]} isn't a ${Object.keys(RUNNERS).join(" or ")} in an app's pinned directory (${pinnedDirs.join(", ") || "the recipe has none"})`); process.exit(2);
}

if (mode === "full") apps("down");
const before = git(tree, "rev-parse", "HEAD");
const checks = [];
for (const app of onlyTest ? [] : recipe.apps || []) {
  const defs = app.checks || {};
  for (const [check, def] of Object.entries(defs)) {
    if (mode === "fast" && !FAST.includes(check)) continue;
    const { cmd, env: needs = [] } = typeof def === "string" ? { cmd: def } : def;
    const unavailable = needs.filter((name) => !Object.hasOwn(env, name));
    const needsApps = !!app.needs_apps?.includes(check);
    checks.push({ app: app.name, check, cmd, ...(needsApps && { needs_apps: true }), ...(unavailable.length
      ? { status: "skipped", ...NOT_RUN, digest: `${unavailable.join(", ")} not available in .factory/env.local` }
      : needsApps ? withApps(app.name, check, cmd) : execute(appDir(tree, app.name), cmd, `${app.name}-${check}`)) });
  }
  if (!defs.test) checks.push({ app: app.name, check: "test", cmd: null, status: "fail", ...NOT_RUN, digest: "required check not in recipe" });
}
// ponytail: the apps go up and down around each pinned test; bring them up once for all if the minutes show it.
for (const rel of pinnedTests) {
  const app = holder(rel), cmd = runner(rel), check = { check: rel, cmd, needs_apps: true, pinned: true };
  checks.push(app ? { app: app.name, ...check, ...withApps(app.name, rel, cmd, path.relative(path.normalize(app.path || "."), rel)) }
    : { app: null, ...check, status: "fail", ...NOT_RUN, digest: "no app's path holds this pinned directory" });
}
// The run's bookkeeping under .factory/ isn't product, but the recipe is. Not lib's git(), whose trim would eat the
// first line's leading status column.
const sha = git(tree, "rev-parse", "HEAD");
const changed = [[".", ":(exclude).factory"], [RECIPE]]
  .flatMap((spec) => execFileSync("git", ["status", "--porcelain", "--", ...spec], { cwd: tree, encoding: "utf8" }).split("\n")).filter(Boolean);
const dirty = changed.length > 0 || sha !== before;
const green = checks.every((c) => c.status === "pass") && !dirty && trusted;
const failed = checks.filter((c) => c.status === "fail");
// ponytail: a check that needs apps isn't rerun at the base, so its red reads introduced; start the base's apps from
// the base worktree if that ever costs a round.
const rerun = failed.filter((c) => c.cmd && !c.needs_apps);
if (rerun.length) atBase(rerun);
// A check missing from the recipe was missing at the base too: the guard keeps a run from writing the recipe.
const red_cause = green ? null
  : failed.length ? (failed.every((c) => !c.cmd || c.at_base?.status === "fail") ? "inherited" : "introduced")
  : dirty || !trusted ? "incomplete" : "environment";
const pinned_only = !green && !dirty && trusted && checks.every((c) => c.status === "pass" || c.pinned);
const evidence = { mode, sha, green, dirty, trusted, red_cause, pinned_only, checks, dirty_detail: changed.slice(0, 20), generated_at: new Date().toISOString() };
const file = path.join(out, mode === "full" ? "evidence.json" : `evidence-${mode}.json`);
fs.writeFileSync(file, JSON.stringify(evidence, null, 2) + "\n");

console.log(`verify ${mode}: green=${green} dirty=${dirty} trusted=${trusted}${red_cause ? ` red_cause=${red_cause}` : ""} sha=${sha.slice(0, 7)} `
  + `${checks.map((c) => `${c.app}/${c.check}=${c.status}`).join(" ")}\nevidence: ${file}`);
for (const c of checks.filter((c) => c.status !== "pass")) console.log(`--- ${c.app}/${c.check} ${c.status}\n${c.digest}`);
process.exit(green ? 0 : 1);
