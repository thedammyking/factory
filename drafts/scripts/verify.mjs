#!/usr/bin/env node
// verify.mjs --fast|--full [--run <id>]
// Runs every check in .factory/setup.json for every app, even after one fails. Writes evidence.json pinned to HEAD.
// marshal-factory semantics: dirty if tree unclean or HEAD moved; untrusted if commands differ from committed recipe.
import fs from "node:fs";
import path from "node:path";
import { spawnSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = findRoot(process.cwd());
const mode = process.argv.includes("--full") ? "full" : "fast";
const runArgIdx = process.argv.indexOf("--run");
const runId = runArgIdx > -1 ? process.argv[runArgIdx + 1] : (fs.existsSync(path.join(ROOT, ".factory/runs/ACTIVE")) ? fs.readFileSync(path.join(ROOT, ".factory/runs/ACTIVE"), "utf8").trim() : null);
const setupPath = path.join(ROOT, ".factory", "setup.json");
const setup = JSON.parse(fs.readFileSync(setupPath, "utf8"));
const state = runId ? JSON.parse(fs.readFileSync(path.join(ROOT, ".factory/runs", runId, "state.json"), "utf8")) : {};
const base = state.base_branch || setup.defaultBranch || "main";
// The run's environment is the recipe's: PATH/HOME plus .factory/env.local, never the developer's shell (so no login profile),
// and {base} reaches a command only as a quoted env reference, never as text spliced into it.
const envFile = path.join(ROOT, ".factory/env.local");
const envLocal = Object.fromEntries((fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "").split("\n")
  .map(l => l.match(/^\s*([A-Za-z_]\w*)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].replace(/^(["'])(.*)\1$/, "$2")]));
const runEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR || "/tmp", ...envLocal, FACTORY_BASE: base };

function findRoot(d) { while (!fs.existsSync(path.join(d, ".factory")) && path.dirname(d) !== d) d = path.dirname(d); return d; }
function sh(cmd) { try { return execSync(cmd, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return ""; } }

const headBefore = sh("git rev-parse HEAD");
// Trusted = the recipe on disk equals the committed recipe (an agent cannot weaken checks mid-run).
const committedRecipe = sh("git show HEAD:.factory/setup.json");
const trusted = committedRecipe.trim() === fs.readFileSync(setupPath, "utf8").trim();

const FAST = new Set(["typecheck", "lint", "test"]);
// --full runs the e2e checks, whose config starts its own servers: a stack left up by run-apps.sh (the QA walk, captures)
// makes them fail on a busy port. Stop it first; the orchestrator brings it back when it needs it.
const runApps = path.join(path.dirname(fileURLToPath(import.meta.url)), "run-apps.sh");  // plugin-owned, beside this script
if (mode === "full" && fs.existsSync(runApps)) {
  const r = spawnSync("bash", [runApps, "down"], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) console.log("verify: run-apps.sh down failed; e2e may hit busy ports\n" + ((r.stdout || "") + (r.stderr || "")).slice(-300));
}
const checks = [];
for (const app of setup.apps || []) {
  for (const [name, cmdTpl] of Object.entries(app.checks || {})) {
    if (mode === "fast" && !FAST.has(name)) continue;
    const cmd = cmdTpl.replaceAll("{base}", '"$FACTORY_BASE"');
    const t0 = Date.now();
    const r = spawnSync("bash", ["-c", cmd], { cwd: path.join(ROOT, app.path || "."), encoding: "utf8", timeout: 10 * 60_000, env: runEnv });
    const out = (r.stdout || "") + (r.stderr || "");
    checks.push({
      app: app.name, check: name, cmd, status: r.status === 0 ? "pass" : "fail", exit: r.status, seconds: Math.round((Date.now() - t0) / 100) / 10,
      tail: out.split("\n").slice(-40).join("\n"),
    });
  }
}
// Required checks that are absent from the recipe are failures, not passes.
for (const app of setup.apps || []) for (const req of ["typecheck", "test"]) {
  if (!(app.checks || {})[req]) checks.push({ app: app.name, check: req, cmd: null, status: "missing", exit: null, seconds: 0, tail: "required check not in recipe" });
}

const headAfter = sh("git rev-parse HEAD");
// "dirty" is about the product tree. The factory's own bookkeeping under .factory/ is excluded, EXCEPT the recipe and
// scripts, which must be clean (and `trusted` separately proves the recipe equals the committed one).
const porcelain = sh("git status --porcelain").split("\n")
  .filter(l => l && !(/\s\.factory\//.test(l) && !/\.factory\/(setup\.json|scripts\/)/.test(l))).join("\n");
const dirty = porcelain.length > 0 || headAfter !== headBefore;
const green = checks.every(c => c.status === "pass") && !dirty && trusted;
const evidence = { mode, sha: headAfter, base_branch: base, dirty, trusted, green, generated_at: new Date().toISOString(), checks,
  dirty_detail: porcelain ? porcelain.split("\n").slice(0, 20) : [] };

if (runId) {
  const dst = path.join(ROOT, ".factory/runs", runId, `evidence${mode === "fast" ? "-fast" : ""}.json`);
  fs.writeFileSync(dst, JSON.stringify(evidence, null, 2) + "\n");
}
const summary = checks.map(c => `${c.app}/${c.check}=${c.status}${c.seconds ? `(${c.seconds}s)` : ""}`).join(" ");
console.log(`VERIFY ${mode} green=${green} dirty=${dirty} trusted=${trusted} sha=${headAfter.slice(0, 7)} ${summary}`);
for (const c of checks.filter(c => c.status !== "pass")) console.log(`--- ${c.app}/${c.check} (${c.status})\n${c.tail}`);
process.exit(green ? 0 : 1);
