// lib.mjs — shared by the factory's scripts. Zero dependencies, Node >= 20.
// A run works in its own worktree, .factory/worktrees/<run>/ under the main checkout, and its run dir sits inside that
// worktree at .factory/runs/<run>/ (untracked). No script guesses the run: each takes --run <id> or derives it from the run
// worktree it runs in.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const readJson = (p, fallback = null) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; } };
export const arg = (k, fallback = null, argv = process.argv) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : fallback; };
// git's worktree and branch commands read every worktree's admin files, so they fail while any other process, another
// run's scripts included, is adding or removing a worktree, and under reftable they can lose the ref lock to another
// writer (docs/platform-facts.md, fact 14). Such a failure has changed nothing (but for the branch a `worktree add -b` makes, so
// no script passes -b), and it's tried again, 5 times in all over about a second.
const RACED = /failed to read .*\/commondir|cannot lock ref/;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export const git = (cwd, ...a) => {
  for (let n = 1; ; n++) try { return execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch (e) {
    if (n === 5 || !["worktree", "branch"].includes(a[0]) || !RACED.test(e.stderr)) throw e;
    pause(100 * n);
  }
};
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

// A ticket's worktree, .factory/worktrees/<run>-NN/, on its local branch factory/<run>/NN (never pushed).
export const ticketWorktree = (main, id, n) => path.join(worktreesDir(main), `${id}-${n}`);
export const ticketBranch = (id, n) => `factory/${id}/${n}`;

// Holds `file` as a lock until this process exits, waiting while a live process holds it and taking it over from one that
// died. Parallel tickets run their scripts at once: run-state holds its run's around each command, so none loses
// another's state.json write, and run-stage its run's merge lock, so ticket branches merge one at a time.
// ponytail: the holder is known by its PID alone, so a PID reused after a crash holds the lock until that process ends,
// and two waiters taking over one dead holder's lock can both get it; add a lease if crashed holders become common.
export function lock(file) {
  for (;;) {
    try { fs.writeFileSync(file, `${process.pid}\n`, { flag: "wx" }); break; } catch (e) { if (e.code !== "EEXIST") throw e; }
    let pid; try { pid = Number(fs.readFileSync(file, "utf8")); } catch { continue; }  // released meanwhile
    let alive = true; try { process.kill(pid, 0); } catch (e) { alive = e.code === "EPERM"; }  // 0, a lock being written, is alive
    if (alive) pause(50); else fs.rmSync(file, { force: true });
  }
  process.on("exit", () => fs.rmSync(file, { force: true }));
}

// The run named by --run, else the one whose worktree holds cwd. Exits 2 when neither names a run with a state.json.
// From a ticket's worktree, ticket is its NN and tree that worktree; otherwise ticket is null and tree the run worktree.
export function runContext() {
  const MAIN = mainRoot();
  let id = arg("--run"), ticket = null;
  const top = git(process.cwd(), "rev-parse", "--show-toplevel");
  if (path.dirname(top) === worktreesDir(MAIN)) {
    const name = path.basename(top), t = name.match(/^(.+)-(\d{2})$/);
    if (t && !fs.existsSync(runPaths(MAIN, name).state) && fs.existsSync(runPaths(MAIN, t[1]).state) && (!id || id === t[1])) [id, ticket] = [t[1], t[2]];
    else id ||= name;
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
  return { MAIN, id, ...paths, ticket, tree: ticket ? top : paths.worktree };
}

// An env file's NAME=value lines as [name, value, raw]: an optional `export`, the value unquoted or else cut at a ` #`
// comment, and raw the text after `=` as written.
// ponytail: one line per value; a quoted value spanning lines keeps only its first line. Parse dotenv's multi-line values
// when a project needs one.
export const envLines = (text) => text.split("\n").flatMap((line) => {
  const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*=\s*(.*)$/);
  if (!m) return [];
  const quoted = m[2].trim().match(/^(["'])(.*)\1$/);
  return [[m[1], quoted ? quoted[2] : m[2].replace(/\s+#.*$/, "").trim(), m[2].trim()]];
});

// The environment every project command runs in: PATH, HOME and TMPDIR, then .factory/env.local from the main checkout
// (untracked, so no worktree has it), then `extra`. Never the developer's shell or login profile.
export function runEnv(main, extra = {}) {
  const file = path.join(main, ".factory", "env.local");
  const local = envLines(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
  return { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, ...Object.fromEntries(local), ...extra };
}

// What a failing command's output reaches agents as, in at most 40 lines: the lines matching an error pattern (the first
// 29 before the last 10), then as many of the last lines as fit, each quoted word for word in log order, then
// `full output: <log>`, where the caller saved all of it.
export function digest(output, log) {
  const text = output.replace(/\n+$/, ""), lines = text ? text.split("\n") : [];
  const hits = lines.flatMap((l, i) => i < lines.length - 10 && /error|fail|assert|expected|exception|✗/i.test(l) ? [i] : []).slice(0, 29);
  const from = Math.max(lines.length - (39 - hits.length), 0);
  return [...hits.filter((i) => i < from).map((i) => lines[i]), ...lines.slice(from), `full output: ${log}`].join("\n");
}

// {port:<app>} and {db} in a command, URL or env value, filled from the apps.json run-apps writes in a run dir. A
// placeholder it can't fill stays as written.
export const fill = (text, apps) =>
  text.replace(/\{port:([^}]+)\}|\{db\}/g, (m, app) => String((app ? apps?.apps?.[app]?.port : apps?.db) ?? m));

// The shared frontier reader, over a folder of NN-slug.md items (a run's tickets). Each has a `Status:` line and a
// `Blocked by:` line (`none`, or the number of each item it waits on), either one bold or not; blockedBy is null without one.
// next is what can be taken now: the in-progress items, then each ready-for-agent item whose blockers are all done.
// open is every item not done.
export const STATUS_LINE = /^(\**Status:\**[ \t]*)(.*)$/m;
export function frontier(dir) {
  const items = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => /^\d{2}-.+\.md$/.test(f)).sort().map((f) => {
    const text = fs.readFileSync(path.join(dir, f), "utf8"), blocked = text.match(/^\**Blocked by:\**[ \t]*(.*)$/m);
    return { id: f.slice(0, -3), n: f.slice(0, 2), file: path.join(dir, f), text,
      status: text.match(STATUS_LINE)?.[2].trim(), blockedBy: blocked && (blocked[1].match(/\d+/g) || []).map((d) => d.padStart(2, "0")) };
  });
  const done = new Set(items.filter((t) => t.status === "done").map((t) => t.n));
  const open = items.filter((t) => t.status !== "done");
  const next = [...open.filter((t) => t.status === "in-progress"),
    ...open.filter((t) => t.status === "ready-for-agent" && (t.blockedBy || []).every((b) => done.has(b)))];
  return { items, open, next, done };
}

// A run's diff, the one review sees: from the merge base of its HEAD and the base it recorded at init (never HEAD~1),
// over PRODUCT, everything but the factory's bookkeeping (the recipe and the rest of .factory/ stay in view). git's
// excludes beat its includes, so the bookkeeping goes path by path. LOCKFILES keeps lockfiles out of a diff's content.
export const PRODUCT = [".", ...[".factory/runs", ".factory/worktrees", ".factory/history", ".factory/maps", ".factory/log.md"].map((p) => `:(exclude)${p}`)];
export const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb"].map((f) => `:(exclude,glob)**/${f}`);
export const runBase = (ctx) => git(ctx.worktree, "merge-base", "HEAD", readJson(ctx.state).base_sha);
// Every path the run's diff changes, and each file's added lines, lockfiles left out: only lines inside a hunk, so no
// header is ever one. A header's path ends in a tab when it holds a space, and is C-quoted when it holds a quote.
export function runDiff(ctx) {
  const base = runBase(ctx);
  const out = (...a) => execFileSync("git", ["-c", "core.quotePath=false", ...a], { cwd: ctx.worktree, encoding: "utf8", maxBuffer: 1 << 28 });
  const files = out("diff", "--name-only", "--no-renames", base, "HEAD", "--", ...PRODUCT).split("\n").filter(Boolean);
  const added = {};
  let file, hunk = false;
  for (const l of out("diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-prefix", base, "HEAD", "--", ...PRODUCT, ...LOCKFILES).split("\n")) {
    if (l.startsWith("diff --git ")) hunk = false;
    else if (!hunk && l.startsWith("+++ ")) { file = l.slice(4).replace(/\t$/, ""); if (file.startsWith('"')) try { file = JSON.parse(file); } catch {} }
    else if (l.startsWith("@@")) hunk = true;
    else if (hunk && l.startsWith("+")) (added[file] ||= []).push(l.slice(1));
  }
  return { base, files, added };
}

// A child's stream-json log or a transcript as its JSON lines, [] when it can't be read; a line that isn't JSON is skipped.
export function events(log) {
  let text; try { text = fs.readFileSync(log, "utf8"); } catch { return []; }
  return text.split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}
// Whether a child or an agent stopped at the usage limit: the last message of its own thread, in a child's stream-json
// log or an agent's transcript, is the one Claude Code writes when a 429 ends a turn, with `error: "rate_limit"`
// (docs/platform-facts.md, fact 13).
export const atUsageLimit = (log) => events(log).filter((e) => e.type === "assistant" && !e.parent_tool_use_id).at(-1)?.error === "rate_limit";
