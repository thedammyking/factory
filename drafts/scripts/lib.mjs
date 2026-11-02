// lib.mjs — shared by the factory's scripts. Zero dependencies, Node >= 20.
// A run's directory (.factory/runs/<id>/) is untracked, so it exists only in the MAIN worktree. Scripts may run in a linked
// worktree (a parallel ticket, or the temp worktrees snapshot, retro-apply and post-merge make): they read the product tree
// from cwd and the run from the main checkout.
// Recipe keys the scripts read from .factory/setup.json: `setup` (the install command a fresh checkout runs),
// `apps[].{name, path, checks}`, `preview.local.<app>.{command, url}`, `preview.<app>.{mode, ...}`, `profiles`, `env`,
// `smoke.command`, `reviewers`, `defaultBranch`.
// CLI for the shell scripts: `node lib.mjs run-dir [--run <id>]` prints the run directory, `node lib.mjs main` the main
// checkout, `node lib.mjs trailer <commit|pr> [--run <id>]` the attribution lines (exit 2 when none were recorded).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const readJson = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
export const arg = (k, d = null, argv = process.argv) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : d; };

// the nearest directory at or above d that holds .factory/: the product tree of this worktree
export function projectRoot(d = process.cwd()) {
  let r = path.resolve(d);
  while (!fs.existsSync(path.join(r, ".factory")) && path.dirname(r) !== r) r = path.dirname(r);
  return r;
}
// the main worktree (the parent of the shared git dir), or the project root itself when that has no .factory/
export function mainRoot(d = process.cwd()) {
  const root = projectRoot(d);
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const main = path.dirname(common);
    return fs.existsSync(path.join(main, ".factory")) ? main : root;
  } catch { return root; }
}
export const runsDir = (d) => path.join(mainRoot(d), ".factory", "runs");
// ACTIVE is JSON {id, branch, session, started_at}; a bare id (runs started before that) still reads
export function activeRun(d) {
  let raw = "";
  try { raw = fs.readFileSync(path.join(runsDir(d), "ACTIVE"), "utf8").trim(); } catch {}
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return { id: raw }; }
}
// what most scripts need: the product tree, the main checkout, and the run named by --run or ACTIVE
export function runContext({ required = true } = {}) {
  const ROOT = projectRoot(), MAIN = mainRoot(ROOT), RUNS = path.join(MAIN, ".factory", "runs");
  const runId = arg("--run") || activeRun(ROOT)?.id || null;
  if (!runId && required) { console.error("no active run: pass --run <id>"); process.exit(2); }
  return { ROOT, MAIN, RUNS, runId, RUN: runId ? path.join(RUNS, runId) : null };
}

// The recipe's environment: PATH, HOME and TMPDIR plus .factory/env.local (untracked, so read from the main checkout).
// Never the developer's shell or login profile.
export function runEnv(main, extra = {}) {
  const f = path.join(main, ".factory", "env.local");
  const local = Object.fromEntries((fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "").split("\n")
    .map(l => l.match(/^\s*(?:export\s+)?([A-Za-z_]\w*)=(.*)$/)).filter(Boolean)
    .map(m => [m[1], m[2].trim().replace(/^(["'])(.*)\1$/, "$2")]));
  return { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR || os.tmpdir(), ...local, ...extra };
}

// The session's attribution lines for commits ("commit") or PR bodies ("pr"): FACTORY_COMMIT_TRAILER / FACTORY_PR_TRAILER
// when exported, else what the orchestrator recorded once with `run-state.mjs set attribution '{"commit":"…","pr":"…"}'`
// (Bash calls do not share env vars, so a one-off export does not reach the next script). Unset refuses; "" means none.
export function trailer(kind, state) {
  const v = process.env[`FACTORY_${kind.toUpperCase()}_TRAILER`] ?? state?.attribution?.[kind];
  if (v === undefined) throw new Error(`no ${kind} attribution: run \`run-state.mjs set attribution '{"commit":"…","pr":"…"}'\` with the session's lines ("" if it requires none)`);
  return v;
}

// Commit onto `base` without checking it out: a detached temp worktree at its tip, where `apply(wt)` writes files and
// returns the paths to stage. The branch then moves by a fast-forward inside the worktree that has it checked out (a live
// clone on develop), or else by a compare-and-swap update-ref. `message` may be a function, called after `apply`.
// Returns the new short SHA, or null when nothing changed.
export function commitToBase(root, base, message, apply) {
  if (!/^(?!-)[\w./-]+$/.test(base)) throw new Error(`base branch '${base}' is not a branch name`);
  const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const old = git(root, "rev-parse", "--verify", `refs/heads/${base}`);
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "factory-base-"));
  git(root, "worktree", "add", "-q", "--detach", wt, old);
  try {
    const paths = apply(wt);
    if (!paths.length) return null;
    git(wt, "add", "--", ...paths);
    try { git(wt, "diff", "--cached", "--quiet"); return null; } catch {}  // staged nothing new
    execFileSync("git", ["commit", "-q", "-F", "-"], { cwd: wt, input: typeof message === "function" ? message() : message });
    const sha = git(wt, "rev-parse", "HEAD");
    const holder = git(root, "worktree", "list", "--porcelain").split("\n\n")
      .find(b => b.split("\n").includes(`branch refs/heads/${base}`))?.match(/^worktree (.+)$/m)?.[1];
    try {
      if (holder) git(holder, "merge", "-q", "--ff-only", sha);
      else git(root, "update-ref", `refs/heads/${base}`, sha, old);
    } catch (e) {
      throw new Error(`committed ${sha.slice(0, 7)} but could not move ${base}${holder ? ` in ${holder}` : ""} (${String(e.stderr || e.message).trim().slice(0, 160)}); merge it by hand: git merge --ff-only ${sha}`);
    }
    return sha.slice(0, 7);
  } finally { git(root, "worktree", "remove", "--force", wt); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const what = process.argv[2];
  if (what === "main") console.log(mainRoot());
  else if (what === "run-dir") console.log(runContext().RUN);
  else if (what === "trailer") {
    const { RUN } = runContext();
    try { process.stdout.write(trailer(process.argv[3], readJson(path.join(RUN, "state.json"), {}))); } catch (e) { console.error(e.message); process.exit(2); }
  } else { console.error("usage: lib.mjs run-dir [--run <id>] | main | trailer <commit|pr> [--run <id>]"); process.exit(2); }
}
