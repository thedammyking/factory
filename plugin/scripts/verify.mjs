#!/usr/bin/env node
// verify.mjs --fast | --full — runs every check in the run worktree's recipe (.factory/setup.json) for every app, never
// stopping at the first failure, and writes the evidence to the run dir: evidence.json for --full, evidence-fast.json for
// --fast (typecheck, lint and test only), so a fast pass never stands in for a full one. Takes --run <id>, or derives the
// run from the run worktree it runs in.
//   - A check is "<command>" or { cmd, env: [names it needs] }. It runs under bash in its app's path with lib's runEnv,
//     its full output saved to logs/<app>-<check>.log in the run dir (.fast.log under --fast); a failing one carries
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
import { readJson, git, worktreesDir, runContext, runEnv, digest, fill } from "./lib.mjs";

const mode = ["fast", "full"].find((m) => process.argv.includes(`--${m}`));
if (!mode) { console.error("verify: usage: verify.mjs --fast | --full [--run <id>]"); process.exit(2); }
const ctx = runContext(), s = readJson(ctx.state), tree = ctx.worktree;
const RECIPE = ".factory/setup.json", FAST = ["typecheck", "lint", "test"];
let text, recipe; try { text = fs.readFileSync(path.join(tree, RECIPE), "utf8"); recipe = JSON.parse(text); } catch (e) {
  console.error(`verify: no recipe at ${path.join(tree, RECIPE)} (${e.message})`); process.exit(2);
}
let committed = null; try { committed = git(tree, "show", `HEAD:${RECIPE}`); } catch {}
const trusted = committed === text.trim();
// {base} reaches a command only as a quoted reference to the base branch, never as text spliced into it.
const env = runEnv(ctx.MAIN, { FACTORY_BASE: s.base_branch });
const logs = path.join(ctx.runDir, "logs");
fs.mkdirSync(logs, { recursive: true });
const appDir = (root, name) => path.join(root, recipe.apps.find((a) => a.name === name).path || ".");
const NOT_RUN = { exit: null, seconds: 0, log: null };
const logOf = (name) => path.join(logs, `${name.replace(/[^\w.-]/g, "_")}${mode === "fast" ? ".fast" : ""}.log`);
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

// Runs a check that needs apps between run-apps up and down.
function withApps(app, check, cmd) {
  const up = apps("up");
  try {
    if (up.status !== 0) {
      const log = logOf(`${app}-${check}`), output = `run-apps up failed\n${up.stdout}${up.stderr}`;
      fs.writeFileSync(log, output);
      return { status: "skipped", ...NOT_RUN, log, digest: digest(output, log) };
    }
    const recorded = readJson(path.join(ctx.runDir, "apps.json"));
    const filled = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, typeof v === "string" ? fill(v, recorded) : v]));
    return execute(appDir(tree, app), fill(cmd, recorded), `${app}-${check}`, filled);
  } finally { apps("down"); }
}

if (mode === "full") apps("down");
const before = git(tree, "rev-parse", "HEAD");
const checks = [];
for (const app of recipe.apps || []) {
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
const evidence = { mode, sha, green, dirty, trusted, red_cause, checks, dirty_detail: changed.slice(0, 20), generated_at: new Date().toISOString() };
const file = path.join(ctx.runDir, mode === "full" ? "evidence.json" : "evidence-fast.json");
fs.writeFileSync(file, JSON.stringify(evidence, null, 2) + "\n");

console.log(`verify ${mode}: green=${green} dirty=${dirty} trusted=${trusted}${red_cause ? ` red_cause=${red_cause}` : ""} sha=${sha.slice(0, 7)} `
  + `${checks.map((c) => `${c.app}/${c.check}=${c.status}`).join(" ")}\nevidence: ${file}`);
for (const c of checks.filter((c) => c.status !== "pass")) console.log(`--- ${c.app}/${c.check} ${c.status}\n${c.digest}`);
process.exit(green ? 0 : 1);
