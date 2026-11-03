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
// the line of a failed git call that says why: its first error: or fatal: line, else its last
export function gitError(e) {
  const lines = String(e.stderr || e.message).trim().split("\n");
  return lines.find((l) => /^(error|fatal):/.test(l)) ?? lines.at(-1);
}

// the main checkout: the parent of the git dir that every worktree shares
export const mainRoot = (dir = process.cwd()) => path.dirname(git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir"));
export const worktreesDir = (main) => path.join(main, ".factory", "worktrees");
export function runPaths(main, id) {
  const worktree = path.join(worktreesDir(main), id), runDir = path.join(worktree, ".factory", "runs", id);
  return { worktree, runDir, state: path.join(runDir, "state.json") };
}

// Commits onto `base` without checking it out: apply(wt) writes into a temp worktree detached at the base tip and returns
// the paths to stage. The base then moves by a fast-forward in the checkout that holds it, else by a compare-and-swap.
// If the move fails (the base moved meanwhile, or the checkout holding it refused), it applies again on the new tip, 3
// tries in all, then throws. Every caller writes a per-run path or appends, so applying again is safe. Returns the new
// commit's SHA, or null when nothing changed.
export function commitToBase(main, base, message, apply) {
  let err;
  for (let n = 0; n < 3; n++) {
    const tip = git(main, "rev-parse", "--verify", `refs/heads/${base}^{commit}`);
    const wt = fs.mkdtempSync(path.join(worktreesDir(main), ".base-"));
    git(main, "worktree", "add", "-q", "--detach", wt, tip);
    try {
      git(wt, "add", "--", ...apply(wt));
      if (!git(wt, "diff", "--cached", "--name-only")) return null;
      // --no-verify: the project's commit hooks expect its dependencies, which a bare temp worktree doesn't have.
      git(wt, "commit", "-q", "--no-verify", "-m", message);
      const sha = git(wt, "rev-parse", "HEAD");
      const holder = git(main, "worktree", "list", "--porcelain").split("\n\n")
        .find((b) => b.split("\n").includes(`branch refs/heads/${base}`))?.match(/^worktree (.+)$/m)[1];
      try {
        if (holder) git(holder, "merge", "-q", "--ff-only", sha);
        else git(main, "update-ref", `refs/heads/${base}`, sha, tip);
        return sha;
      } catch (e) { err = e; }
    } finally { git(main, "worktree", "remove", "--force", wt); }
  }
  throw new Error(`3 tries couldn't move ${base} (${gitError(err)})`);
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
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) { console.error(`no run ${id}`); process.exit(2); }
  const paths = runPaths(MAIN, id);
  if (!fs.existsSync(paths.state)) {
    // A finished run's worktree is gone after its snapshot; its record on the base branch says how it ended.
    const record = `.factory/history/${id}/state.json`, sha = git(MAIN, "log", "--all", "-1", "--format=%H", "--", record);
    const ended = sha && JSON.parse(git(MAIN, "show", `${sha}:${record}`));
    console.error(ended ? `run ${id} has ended ${ended.stage}: its record is .factory/history/${id}/ on ${ended.base_branch}` : `no run ${id}`);
    process.exit(2);
  }
  return { MAIN, id, ...paths };
}
