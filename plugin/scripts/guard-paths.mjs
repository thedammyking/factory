#!/usr/bin/env node
// guard-paths.mjs — the PreToolUse hook. Reads the hook input on stdin; exit 2 with the reason on stderr denies the tool call.
// It binds only the factory's own agents, the plugin's subagents and the implementer child, whose calls carry an
// agent_type starting with factory: (docs/platform-facts.md, fact 7). The developer's session carries none, orchestrator
// turns included, so it writes wherever the developer asks.
// It does nothing outside a factory project (a current worktree without .factory/). The current worktree is the one the
// session started in (CLAUDE_PROJECT_DIR), since the input's cwd follows every `cd` (docs/platform-facts.md).
// Every Write, Edit and shell write must land in the current worktree, its run dir (a ticket worktree's is in the run
// worktree beside it), /dev/ or /tmp/. Targets are compared after resolving symlinks, in the case on disk, and a target
// that is itself a symlink or a hard link is refused, so no link carries a write out.
// While the run of the worktree a write lands in hasn't ended, the factory's own files, .claude/, CI and lint config are
// locked, and the recipe's pinned directories (setup.json `pinned`, a list of paths) take writes only from the factory's
// qa agent. Reads and script calls are never denied: of a Bash command, only what it writes is checked.
// ponytail: a tokenizer, not a shell: no variable expansion but $HOME, no globs, no xargs, find -exec, curl -o or tar -C.
//           The permission system bounds what else a command can do.
import fs from "node:fs";
import path from "node:path";
import { readJson, git, worktreesDir, runPaths, LOCKED } from "./lib.mjs";

const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
if (!/^factory:/.test(input.agent_type)) process.exit(0);
const cwd = path.resolve(input.cwd || process.cwd()), project = process.env.CLAUDE_PROJECT_DIR || cwd;
let top, common;
try { [top, common] = git(project, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir").split("\n"); } catch { process.exit(0); }
if (!fs.existsSync(path.join(top, ".factory"))) process.exit(0);
const tool = input.tool_name, ti = input.tool_input || {};
const HOME = process.env.HOME || "/";

const exists = (a) => { try { fs.lstatSync(a); return true; } catch { return false; } };
const isLink = (a) => { try { const s = fs.lstatSync(a); return s.isSymbolicLink() || (s.isFile() && s.nlink > 1); } catch { return false; } };
// the realpath, in the case on disk, of a's longest existing ancestor plus the missing rest; null when that ancestor is a
// dangling link
const real = (a) => { const tail = []; while (!exists(a) && path.dirname(a) !== a) { tail.unshift(path.basename(a)); a = path.dirname(a); }
  try { return path.join(fs.realpathSync.native(a), ...tail); } catch { return null; } };
const under = (r, dir) => !!dir && (r === dir || r.startsWith(dir + path.sep));
const abs = (dir, p) => path.resolve(dir, p.replace(/^(~|\$HOME|\$\{HOME\})(?=$|\/)/, HOME));

const MAIN = path.dirname(common), WTS = real(worktreesDir(MAIN)), TOP = real(top), TMP = fs.realpathSync.native("/tmp");
// A worktree's run: a run worktree is named after its run, a ticket worktree after its run plus -NN.
function runOf(wt) {
  if (path.dirname(wt) !== WTS) return null;
  const name = path.basename(wt);
  for (const id of [name, name.replace(/-\d+$/, "")]) { const s = readJson(runPaths(MAIN, id).state); if (s) return { id, stage: s.stage }; }
  return null;
}
const own = runOf(TOP), roots = [TOP, own && real(runPaths(MAIN, own.id).runDir)];
const TERMINAL = ["delivered", "needs-human", "failed", "abandoned", "answered", "charted"];  // run-state's outcomes
// Locked while a run goes on: lib's LOCKED, matched in lower case for case-insensitive file systems. LOCKED_DIRS are the
// ones a removal can take whole.
const LOCKED_DIRS = [".factory/", ".claude/", ".github/workflows/", ".github/actions/"];

// why a write to the absolute path a is refused, or null; a removal also writes everything a holds
function refuse([a, removes]) {
  const r = real(a);
  if (r && (under(r, "/dev") || under(r, TMP))) return null;
  if (isLink(a)) return `${a} is a symlink or a hard link, and no write goes through one`;
  if (!r || !roots.some((d) => under(r, d))) return `${a} is outside this worktree and its run dir`;
  // The run that matters is that of the worktree the write lands in: a subagent in the main checkout reaches into them all.
  const wt = under(r, WTS) && r !== WTS ? path.join(WTS, path.relative(WTS, r).split(path.sep)[0]) : TOP, run = runOf(wt);
  if (!run || TERMINAL.includes(run.stage)) return null;
  const rel = path.relative(wt, r).toLowerCase(), holds = (k) => removes && (rel === "" || k.startsWith(rel + "/"));
  if (LOCKED.test(rel) || [...LOCKED_DIRS, `.factory/runs/${run.id}/state.json`].some(holds)) return `${a} is locked while run ${run.id} goes on`;
  if (input.agent_type === "factory:qa") return null;  // the value proven in docs/platform-facts.md
  const pinned = [].concat(readJson(path.join(wt, ".factory", "setup.json"))?.pinned ?? []).map((d) => path.normalize(String(d)).replace(/\/+$/, "").toLowerCase());
  if (pinned.some((d) => under(rel, d) || holds(d + "/"))) return `${a} is in a pinned directory, which only factory:qa writes while run ${run.id} goes on`;
  return null;
}
// targets as [absolute path, whether the write removes it]
const check = (targets) => {
  const why = [...new Set(targets.map(refuse).filter(Boolean))];
  if (why.length) { process.stderr.write(`guard-paths: ${why.join("; ")}\n`); process.exit(2); }
};

if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
  const file = ti.file_path || ti.notebook_path;
  if (file) check([[abs(cwd, file), false]]);
  process.exit(0);
}
if (tool !== "Bash") process.exit(0);

// Simple commands as word lists. Quotes are removed but keep their content in one word; an unquoted redirect operator is
// its own word, prefixed with OP (a digit fd before it is dropped). A subshell or a $(…) or `…` substitution, quoted or not,
// is a { sub } of its own, so a `cd` in it stays there; a substitution's value is an unknown, empty word. Heredoc bodies are
// skipped: they're data.
const OP = "\0";
function parse(cmd) {
  const cmds = []; let words = [], w = "", quoted = false, q = null, heredocs = [];
  const endWord = () => {
    if (w || quoted) { if (words.at(-1) === OP + "<<") heredocs.push(w.replace(/^-/, "")); words.push(w); }
    w = ""; quoted = false;
  };
  const endCmd = () => { endWord(); if (words.length) cmds.push(words); words = []; };
  const sub = (open) => { const end = closing(cmd, open); cmds.push({ sub: cmd.slice(open + 1, end) }); return end; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q === "'") { if (c === q) q = null; else w += c; }
    else if (c === "\\") { if (cmd[i + 1] !== "\n") w += cmd[i + 1] ?? ""; i++; }  // a backslash-newline continues the line
    else if (c === "`" || (c === "$" && cmd[i + 1] === "(")) { i = sub(c === "`" ? i : i + 1); quoted = true; }
    else if (q) { if (c === q) q = null; else w += c; }
    else if (c === "'" || c === '"') { q = c; quoted = true; }
    else if (c === ">" || c === "<" || (c === "&" && cmd[i + 1] === ">")) {
      if (/^\d+$/.test(w) && !quoted) w = ""; else endWord();
      let op = c; while (/[<>&]/.test(cmd[i + 1] || "") || (cmd[i + 1] === "|" && op === ">")) op += cmd[++i];
      words.push(OP + op);
    }
    else if (c === "(") { endCmd(); i = sub(i); }
    else if (c === "\n") { endCmd(); for (const d of heredocs) i = bodyEnd(cmd, i, d); heredocs = []; }
    else if (";|&)".includes(c)) endCmd();
    else if (/\s/.test(c)) endWord();
    else w += c;
  }
  endCmd(); return cmds;
}
// the index of the ` or ) that closes the ` or ( at i
function closing(cmd, i) {
  if (cmd[i] === "`") { let j = i + 1; while (j < cmd.length && cmd[j] !== "`") j += cmd[j] === "\\" ? 2 : 1; return j; }
  for (let j = i, depth = 0, q = null; j < cmd.length; j++) {
    const c = cmd[j];
    if (q) { if (c === q) q = null; else if (c === "\\" && q === '"') j++; }
    else if (c === "'" || c === '"') q = c;
    else if (c === "\\") j++;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return j;
  }
  return cmd.length;
}
// the index of the newline that ends the line closing heredoc d, whose body starts after index i
function bodyEnd(cmd, i, d) {
  while (i < cmd.length) {
    const e = cmd.indexOf("\n", i + 1), end = e < 0 ? cmd.length : e;
    if (cmd.slice(i + 1, end).replace(/^\t+/, "") === d) return end;
    i = end;
  }
  return i;
}
const WRAPPERS = new Set(["sudo", "env", "command", "exec", "nohup", "time", "nice"]);
const IN_PLACE = { sed: /^-[a-zA-Z]*i|^--in-place/, perl: /^-[a-z]*i/, ruby: /^-[a-z]*i/ };
const INLINE = { node: ["-e", "--eval", "-p", "--print"], bun: ["-e", "--eval"], deno: ["eval"], python: ["-c"], python3: ["-c"], perl: ["-e", "-E"], ruby: ["-e"] };
const WRITES = /writeFile|appendFile|createWriteStream|copyFile|rename|unlink|rmSync|rmdir|mkdir|open\([^)]*['"][wax+]|write_text|write_bytes|shutil\.|os\.(remove|replace)|File\.(write|open)|>>?\s*['"]?\//;
// what a command line run from dir writes, as targets
function targets(cmd, dir) {
  const out = [], add = (removes, files) => { for (const f of files) if (f) out.push([abs(dir, f), removes]); };
  for (const words of parse(cmd)) {
    if (words.sub !== undefined) { out.push(...targets(words.sub, dir)); continue; }
    const plain = [];
    for (let i = 0; i < words.length; i++) {
      if (!words[i].startsWith(OP)) { plain.push(words[i]); continue; }
      const op = words[i].slice(1), t = words[++i];
      // `>&2` / `2>&1` duplicate a descriptor; `<` and `<<` read
      if (op.includes(">") && t !== undefined && !t.startsWith(OP) && !(op.endsWith("&") && /^(\d+|-)$/.test(t))) add(false, [t]);
    }
    let k = 0;
    while (k < plain.length && (/^[A-Za-z_]\w*=/.test(plain[k]) || WRAPPERS.has(plain[k]) || (k && WRAPPERS.has(plain[k - 1]) && plain[k].startsWith("-")))) k++;
    let prog = path.basename(plain[k] || ""), rest = plain.slice(k + 1);
    if (prog === "git" && ["rm", "mv"].includes(rest[0])) { prog = rest[0]; rest = rest.slice(1); }
    const files = rest.filter((a) => !a.startsWith("-")), script = rest.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    // `cd` alone goes home, and to an unknown dir (a substitution's) it is taken to stay put
    if (prog === "cd") { if (!rest.length) dir = HOME; else if (files[0]) dir = abs(dir, files[0]); }
    else if (prog === "mv") { add(true, files.slice(0, -1)); add(false, files.slice(-1)); }
    else if (["cp", "rsync", "ln", "install"].includes(prog)) add(false, files.slice(-1));
    else if (["rm", "rmdir", "unlink", "shred"].includes(prog)) add(true, files);
    else if (["tee", "mkdir", "touch", "truncate"].includes(prog)) add(false, files);
    else if (["chmod", "chown", "chgrp"].includes(prog)) add(false, files.slice(1));
    else if (prog === "dd") add(false, rest.filter((a) => a.startsWith("of=")).map((a) => a.slice(3)));
    else if (["bash", "sh", "zsh", "dash"].includes(prog) && script > -1) out.push(...targets(rest[script + 1] || "", dir));
    else if (prog === "eval") out.push(...targets(rest.join(" "), dir));
    if (IN_PLACE[prog] && rest.some((a) => IN_PLACE[prog].test(a))) add(false, files);
    if (INLINE[prog]) {
      // the path-like literals (a / or a . in them) of code that writes
      const i = rest.findIndex((a) => INLINE[prog].includes(a)), code = i > -1 ? rest[i + 1] || "" : "";
      if (WRITES.test(code)) add(false, [...code.matchAll(/(["'`])(.*?)\1/g)].map((m) => m[2]).filter((s) => /^\S*[./]\S*$/.test(s)));
    }
  }
  return out;
}
check(targets(String(ti.command || ""), cwd));
