// lib.mjs — shared by the factory's scripts. Zero dependencies, Node >= 20.
// A run works in its own worktree, .factory/worktrees/<run>/ under the main checkout, and its run dir sits inside that
// worktree at .factory/runs/<run>/ (untracked). No script guesses the run: each takes --run <id> or derives it from the run
// worktree it runs in.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const readJson = (p, fallback = null) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; } };
export const arg = (k, fallback = null, argv = process.argv) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : fallback; };
export const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// the main checkout: the parent of the git dir that every worktree shares
export const mainRoot = (dir = process.cwd()) => path.dirname(git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir"));
export const worktreesDir = (main) => path.join(main, ".factory", "worktrees");
export function runPaths(main, id) {
  const worktree = path.join(worktreesDir(main), id), runDir = path.join(worktree, ".factory", "runs", id);
  return { worktree, runDir, state: path.join(runDir, "state.json") };
}

// The run named by --run, else the one whose worktree holds cwd. Exits 2 when neither names a run with a state.json.
export function runContext() {
  const MAIN = mainRoot();
  let id = arg("--run");
  if (!id) {
    const top = git(process.cwd(), "rev-parse", "--show-toplevel");
    if (path.dirname(top) === worktreesDir(MAIN)) id = path.basename(top);
  }
  if (!id) { console.error("no run: pass --run <id>, or run inside the run's worktree"); process.exit(2); }
  const paths = runPaths(MAIN, id);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || !fs.existsSync(paths.state)) { console.error(`no run ${id}`); process.exit(2); }
  return { MAIN, id, ...paths };
}
