// lib.mjs — shared by the factory's scripts. Zero dependencies, Node >= 20.
// A run works in its own worktree, .factory/worktrees/<run>/ under the main checkout, and its run dir sits inside that
// worktree at .factory/runs/<run>/ (untracked). No script guesses the run: each takes --run <id> or derives it from the run
// worktree it runs in.
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

export const readJson = (p, fallback = null) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; } };
export const arg = (k, fallback = null, argv = process.argv) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : fallback; };
// git's worktree and branch commands read every worktree's admin files, so they fail while any other process, another
// run's scripts included, is adding or removing a worktree, and under reftable they can lose the ref lock to another
// writer (docs/platform-facts.md, fact 14). Such a failure has changed nothing (but for the branch a `worktree add -b` makes, so
// no script passes -b), and it's tried again, 5 times in all over about a second.
const RACED = /failed to read .*\/commondir|cannot lock ref/;
export const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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

// `text`, a commit message ("commit") or a PR body ("pr"), ending in the session's attribution lines: FACTORY_COMMIT_TRAILER
// or FACTORY_PR_TRAILER when exported, else those the orchestrator recorded in `state` right after init (Bash calls share
// no env), "" being none. With neither, a run's text goes without them, which stderr says once a process: a snapshot or a
// revert never fails for want of a trailer.
let unattributed = false;
export function attributed(text, kind, state) {
  const lines = process.env[`FACTORY_${kind.toUpperCase()}_TRAILER`] ?? state?.attribution?.[kind];
  if (lines === undefined && state && !unattributed) {
    unattributed = true;
    console.error(`no attribution recorded, so the run's commits and PRs go without: run-state set attribution '{"commit":"…","pr":"…"}' records the session's`);
  }
  return lines ? `${text.trimEnd()}\n\n${lines.trim()}` : text;
}

// Commits onto `base` without checking it out: apply(wt) writes into a temp worktree detached at the base tip and returns
// the paths to stage. The base then moves by a fast-forward in the checkout that holds it, else by a compare-and-swap.
// If the move fails (the base moved meanwhile, or the checkout holding it refused), it applies again on the new tip, 3
// tries in all, then throws. Every caller writes a per-run path or appends, or, as map.mjs does, checks the tip in
// apply and throws there (committing nothing) when another writer got in first, so applying again is safe. Returns the new
// commit's SHA, or null when nothing changed.
export function commitToBase(main, base, message, apply) {
  let err;
  fs.mkdirSync(worktreesDir(main), { recursive: true });  // a project with no run yet has none
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
// From a ticket's worktree, ticket is its NN, tree that worktree and out tickets/<NN>/ in the run dir; otherwise ticket
// is null, tree the run worktree and out the run dir. out holds what is the worktree's own: its apps, evidence and logs.
// From <run>-try, `preview.mjs try`'s worktree of an ended run's PR, which only run-apps runs in, tree and out are in it,
// with no worktree, runDir or state.
export function runContext() {
  const MAIN = mainRoot();
  let id = arg("--run"), ticket = null;
  const top = git(process.cwd(), "rev-parse", "--show-toplevel");
  if (path.dirname(top) === worktreesDir(MAIN)) {
    const name = path.basename(top), t = name.match(/^(.+)-(\d{2})$/);
    const trial = !id && !fs.existsSync(runPaths(MAIN, name).state) && name.match(/^([a-z0-9][a-z0-9-]*)-try$/);
    if (t && !fs.existsSync(runPaths(MAIN, name).state) && fs.existsSync(runPaths(MAIN, t[1]).state) && (!id || id === t[1])) [id, ticket] = [t[1], t[2]];
    else if (trial) return { MAIN, id: trial[1], ticket: null, tree: top, out: path.join(top, ".factory", "runs", trial[1]) };
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
  return { MAIN, id, ...paths, ticket, tree: ticket ? top : paths.worktree, out: ticket ? path.join(paths.runDir, "tickets", ticket) : paths.runDir };
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

// The watch's smoke command's environment alone (#32): runEnv's, with each WATCH_X in .factory/env.local taking X's
// place, so the smoke signs in as the target's test user.
export function watchEnv(main) {
  const env = runEnv(main);
  for (const [k, v] of Object.entries(env)) if (/^WATCH_./.test(k)) env[k.slice(6)] = v;
  return env;
}
// The recipe's smoke.headers, each {env:NAME} filled from env; a header whose variable env lacks is left out.
export const smokeHeaders = (recipe, env) => Object.fromEntries(Object.entries(recipe.smoke?.headers || {}).flatMap(([name, v]) => {
  let gap = false;
  const value = String(v).replace(/\{env:([^}]+)\}/g, (_, n) => env[n] || (gap = true, ""));
  return gap ? [] : [[name, value]];
}));
// One GET of url's root with `headers`, its redirect never followed, so they reach that origin alone: a login wall (#32)
// is a 401, a 403 or a redirect off its host, and no answer, or a redirect that names no host, counts as one.
// { wall, why }, why naming the status and a redirect's host, never a header.
export async function loginWall(url, headers = {}) {
  const root = new URL("/", url);
  let r; try { r = await fetch(root, { headers, redirect: "manual", signal: AbortSignal.timeout(30_000) }); } catch (e) { return { wall: true, why: `no answer: ${e.cause?.code ?? e.message}` }; }
  r.body?.cancel().catch(() => {});
  let to = null; try { to = r.headers.has("location") ? new URL(r.headers.get("location"), root).host : null; } catch {}
  const moved = r.status >= 300 && r.status < 400;
  return { wall: [401, 403].includes(r.status) || (moved && to !== root.host), why: `${r.status}${moved ? ` to ${to ?? "nowhere it names"}` : ""}` };
}

// The one device a run's mobile apps go on, from .factory/env.local as setup records it: the iOS simulator
// FACTORY_IOS_DEVICE (its UDID) where the machine has one, else the Android emulator FACTORY_ANDROID_DEVICE (its AVD
// name); null with neither, which NO_DEVICE says.
export const device = (env) => env.FACTORY_IOS_DEVICE ? { platform: "ios", id: env.FACTORY_IOS_DEVICE }
  : env.FACTORY_ANDROID_DEVICE ? { platform: "android", id: env.FACTORY_ANDROID_DEVICE } : null;
export const NO_DEVICE = "no device in .factory/env.local (FACTORY_IOS_DEVICE or FACTORY_ANDROID_DEVICE)";
// A device command (xcrun, adb, emulator): its trimmed stdout, else it throws, naming the command and what it said.
export function cli(bin, ...args) {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: 5 * 60_000 });
  if (r.status !== 0) throw new Error(`${bin} ${args.join(" ")}: ${(r.error?.message || r.stderr || r.stdout || `exit ${r.status}`).trim()}`);
  return r.stdout.trim();
}
// Each platform a run didn't verify on (all of them when `verified`, the evidence's platform, is null) whose native code
// `files` change, its ios/ or android/ in a mobile app's path, as [{ platform, files }] (#17).
export const PLATFORM_NAMES = { ios: "iOS", android: "Android" };
export const unverifiedNative = (recipe, verified, files) => Object.keys(PLATFORM_NAMES).filter((p) => p !== verified).map((platform) => ({ platform,
  files: files.filter((f) => (recipe.apps || []).some((a) => a.type === "mobile" && f.startsWith(`${path.posix.join(a.path || ".", platform)}/`))) }))
  .filter((u) => u.files.length);

// What a failing command's output reaches agents as, in at most 40 lines: the lines matching an error pattern (the first
// 29 before the last 10), then as many of the last lines as fit, each quoted word for word in log order, then
// `full output: <log>`, where the caller saved all of it.
export function digest(output, log) {
  const text = output.replace(/\n+$/, ""), lines = text ? text.split("\n") : [];
  const hits = lines.flatMap((l, i) => i < lines.length - 10 && /error|fail|assert|expected|exception|✗/i.test(l) ? [i] : []).slice(0, 29);
  const from = Math.max(lines.length - (39 - hits.length), 0);
  return [...hits.filter((i) => i < from).map((i) => lines[i]), ...lines.slice(from), `full output: ${log}`].join("\n");
}

// {port:<app>} and {db} in a command, URL or env value, filled from the apps.json run-apps writes in a worktree's out. A
// placeholder it can't fill stays as written.
export const fill = (text, apps) =>
  text.replace(/\{port:([^}]+)\}|\{db\}/g, (m, app) => String((app ? apps?.apps?.[app]?.port : apps?.db) ?? m));

// The shared frontier reader, over a folder of NN-slug.md items (a run's tickets, or a map's decision tickets). Each has a
// `Status:` line and a `Blocked by:` line (`none`, or the number of each item it waits on), either one bold or not;
// blockedBy is null without one. next is what can be taken now: the started items, then each ready item whose blockers are
// all closed. open is every item not closed, and done the numbers of those closed. `words` names the statuses, a run's
// tickets' by default; `files` (name -> text) stands in for the folder on disk, as map.mjs reads its base branch's tree.
export const STATUS_LINE = /^(\**Status:\**[ \t]*)(.*)$/m;
export function frontier(dir, { closed = ["done"], started = "in-progress", ready = "ready-for-agent" } = {}, files = null) {
  const items = (files ? Object.keys(files) : fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => /^\d{2}-.+\.md$/.test(f)).sort().map((f) => {
    const text = files ? files[f] : fs.readFileSync(path.join(dir, f), "utf8"), blocked = text.match(/^\**Blocked by:\**[ \t]*(.*)$/m);
    return { id: f.slice(0, -3), n: f.slice(0, 2), file: path.join(dir, f), text,
      status: text.match(STATUS_LINE)?.[2].trim(), blockedBy: blocked && (blocked[1].match(/\d+/g) || []).map((d) => d.padStart(2, "0")) };
  });
  const done = new Set(items.filter((t) => closed.includes(t.status)).map((t) => t.n));
  const open = items.filter((t) => !closed.includes(t.status));
  const next = [...open.filter((t) => t.status === started),
    ...open.filter((t) => t.status === ready && (t.blockedBy || []).every((b) => done.has(b)))];
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

// The paths no run may change on its own: the factory's own files (all of .factory/ but the run dirs, plus each run's
// state.json, which run-state alone writes, so no agent ends its run to unlock the rest), .claude/, CI workflows and
// actions, and lint config. guard-paths locks them while a run goes on; a run's diff touching one needs a human.
export const LOCKED = /^(\.factory\/(?!runs\/)|\.factory\/runs\/[^/]+\/state\.json$|\.claude\/|\.github\/(workflows|actions)\/)|(^|\/)(eslint\.config\.|\.eslint|prettier\.config\.|\.prettier|biome\.jsonc?$|stylelint\.config\.|\.stylelint|\.swiftlint\.ya?ml$|\.?ruff\.toml$|\.golangci\.)/;

// The base a PR merges into, as a ref: origin's copy of `branch`, fetched now, when the project has an origin (throwing
// when the fetch fails), else the local branch. A local base may hold commits origin never got, such as snapshots.
export function liveBase(cwd, branch) {
  try { git(cwd, "remote", "get-url", "origin"); } catch { return `refs/heads/${branch}`; }
  git(cwd, "fetch", "-q", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
  return `refs/remotes/origin/${branch}`;
}
// owner/name of the GitHub repo origin's configured URL names, or null. The URL as configured, before any insteadOf.
export function githubRepo(cwd) {
  try { return git(cwd, "config", "--get", "remote.origin.url").match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/)?.[1] ?? null; } catch { return null; }
}
// One `gh api <args>` call, REST but for the review threads pr-comments and pr-resolve need, which only GraphQL has
// (`gh api graphql`): { ok, json, text, message }, text being the body as it came (a job's log isn't JSON) and message
// GitHub's own words on a refusal (its message, then each error's), else gh's, else why gh didn't start.
export function ghApi(...args) {
  const r = spawnSync("gh", ["api", ...args], { encoding: "utf8", maxBuffer: 1 << 28 });
  let json = null; try { json = JSON.parse(r.stdout); } catch {}
  const message = [json?.message, ...(json?.errors || []).map((e) => e.message ?? e)].filter(Boolean).join(": ") || (r.stderr || "").trim() || r.error?.message || "";
  return { ok: r.status === 0, json, text: r.stdout ?? "", message };
}
// A value as one shell word, for a command a human pastes: as it is when plain, else single-quoted.
export const shellQuote = (v) => /^[\w./@:+=~-]+$/.test(String(v)) ? String(v) : `'${String(v).replaceAll("'", "'\\''")}'`;
// An attention item's text, in the factory skill's one shape. options: [[a runnable command, what it does], …].
export const attentionItem = ({ id, stage, headline, happened, evidence, recommendation, options }) =>
  `# ${headline}\n\nRun \`${id}\`, stage \`${stage}\`.\n\n## What happened\n${happened}\n\n## Evidence\n${evidence.map((e) => `- \`${e}\``).join("\n")}\n\n`
  + `## Recommendation\n${recommendation}\n\n## Options\n${options.map(([c, what]) => `- \`${c}\`: ${what}`).join("\n")}\n`;

// A child's stream-json log or a transcript as its JSON lines, [] when it can't be read; a line that isn't JSON is skipped.
export function events(log) {
  let text; try { text = fs.readFileSync(log, "utf8"); } catch { return []; }
  return text.split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}
// Whether a child or an agent stopped at the usage limit: the last message of its own thread, in a child's stream-json
// log or an agent's transcript, is the one Claude Code writes when a 429 ends a turn, with `error: "rate_limit"`
// (docs/platform-facts.md, fact 13).
export const atUsageLimit = (log) => events(log).filter((e) => e.type === "assistant" && !e.parent_tool_use_id).at(-1)?.error === "rate_limit";
