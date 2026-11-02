#!/usr/bin/env node
// guard-paths.mjs — PreToolUse hook. Reads the hook JSON on stdin; exit 2 (+ stderr) denies the tool call, exit 0 allows.
// Only in a factory project (a .factory/ at or above cwd); elsewhere the plugin stays out of the way.
// Rules: Write/Edit/MultiEdit/NotebookEdit must target a path inside the project (the worktree) or the run directory, which
//        lives in the main checkout when the agent works in a linked worktree.
//        Bash must not write outside them. The command is split into simple commands on unquoted ; & | ( ) and newlines,
//        `cd` is followed, and these are checked: redirects (not >&N), tee, cp/mv/rsync/ln/install destinations, git rm/mv,
//        rm/rmdir/mkdir/touch/truncate/unlink/chmod/chown targets, sed -i files, dd of=, `bash -c` scripts (recursively), and
//        inline node/python/perl/ruby code that writes files (judged by the path literals it names). Reads anywhere are fine.
//        /dev/ and /tmp/ are allowed. Paths are compared after resolving symlinks, and a write whose target is itself a symlink
//        is refused, so a link inside the worktree cannot carry a write outside it.
//        During an active run, protected files (recipe, scripts, CI, lint config, .claude/) may not be written at all.
// ponytail: a tokenizer, not a shell: no variable or glob expansion, no heredoc bodies, no pushd, no xargs. The Write/Edit rule
//           is the real boundary for file tools; for Bash the real boundary is an OS sandbox, this catches the common forms.
import fs from "node:fs";
import path from "node:path";
import { projectRoot, runsDir, activeRun } from "./lib.mjs";

const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
const cwd = path.resolve(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
const proj = projectRoot(cwd);
if (!fs.existsSync(path.join(proj, ".factory"))) process.exit(0);
const tool = input.tool_name || "";
const ti = input.tool_input || {};
const HOME = process.env.HOME || "~";
const deny = (msg) => { process.stderr.write(`guard-paths: ${msg}\n`); process.exit(2); };
const runActive = !!activeRun(proj);
const PROTECTED = /(^|\/)(\.factory\/setup\.json|\.factory\/scripts\/|\.factory\/agents\/|\.claude\/|\.github\/workflows\/|eslint\.config\.|\.eslintrc|prettier\.config|\.prettierrc|biome\.json)/;

const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
// realpath of the longest existing ancestor + the missing tail; null when that ancestor is a dangling link
const real = (a) => { const tail = []; while (!exists(a) && path.dirname(a) !== a) { tail.unshift(path.basename(a)); a = path.dirname(a); }
  try { return path.join(fs.realpathSync(a), ...tail); } catch { return null; } };
const realRoot = fs.realpathSync(proj);
const RUNS = real(runsDir(proj));
const TMP = fs.realpathSync("/tmp");
const under = (r, dir) => !!dir && (r === dir || r.startsWith(dir + path.sep));
const isLink = (a) => { try { return fs.lstatSync(a).isSymbolicLink(); } catch { return false; } };
const abs = (dir, p) => path.resolve(dir, p.replace(/^~(?=$|\/)/, HOME));
// why a write to the absolute path a is refused, or null
const refuse = (a) => {
  const r = real(a);
  if (r && under(r, "/dev")) return null;
  if (isLink(a)) return `write through a symlink refused: ${a}`;
  if (!r || !(under(r, realRoot) || under(r, RUNS) || under(r, TMP))) return `write outside the worktree refused: ${a}`;
  if (runActive && under(r, realRoot) && PROTECTED.test(path.relative(realRoot, r))) return `protected during an active run: ${a}`;
  return null;
};

if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
  const p = ti.file_path || ti.notebook_path || "";
  const why = p && refuse(abs(cwd, p));
  if (why) deny(why);
  process.exit(0);
}
if (tool !== "Bash") process.exit(0);

// Simple commands as word lists. Quotes are removed but keep their content in one word; an unquoted redirect operator is
// its own word, prefixed with OP (a digit fd before it is dropped).
const OP = "\0";
function parse(cmd) {
  const cmds = []; let words = [], w = "", quoted = false, q = null;
  const endWord = () => { if (w || quoted) words.push(w); w = ""; quoted = false; };
  const endCmd = () => { endWord(); if (words.length) cmds.push(words); words = []; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) { if (c === q) q = null; else if (c === "\\" && q === '"') w += cmd[++i] ?? ""; else w += c; continue; }
    if (c === "'" || c === '"') { q = c; quoted = true; }
    else if (c === "\\") w += cmd[++i] ?? "";
    else if (c === ">" || c === "<" || (c === "&" && cmd[i + 1] === ">")) {
      if (/^\d+$/.test(w) && !quoted) w = ""; else endWord();
      let op = c; while (/[<>&]/.test(cmd[i + 1] || "") || (cmd[i + 1] === "|" && op === ">")) op += cmd[++i];
      words.push(OP + op);
    }
    else if (";|&()\n".includes(c)) endCmd();
    else if (/\s/.test(c)) endWord();
    else w += c;
  }
  endCmd(); return cmds;
}
const WRAPPERS = new Set(["sudo", "env", "command", "exec", "nohup", "time", "nice"]);
const INLINE = { node: ["-e", "--eval", "-p", "--print"], bun: ["-e", "--eval"], deno: ["eval"], python: ["-c"], python3: ["-c"], perl: ["-e", "-E"], ruby: ["-e"] };
const WRITES = /writeFile|appendFile|createWriteStream|copyFile|rename|unlink|rmSync|rmdir|mkdir|open\([^)]*['"][wax+]|write_text|write_bytes|shutil\.|os\.(remove|replace)|File\.(write|open)|>>?\s*['"]?\//;
function targets(cmd, dir) {
  const out = [];
  for (const words of parse(cmd)) {
    const plain = [];
    for (let i = 0; i < words.length; i++) {
      if (!words[i].startsWith(OP)) { plain.push(words[i]); continue; }
      const op = words[i].slice(1), t = words[++i];
      // `>&2` / `2>&1` duplicate a descriptor; `<` and `<<` read
      if (op.includes(">") && t !== undefined && !t.startsWith(OP) && !(op.endsWith("&") && /^(\d+|-)$/.test(t))) out.push(abs(dir, t));
    }
    let k = 0;
    const skip = () => { while (k < plain.length && (/^[A-Za-z_]\w*=/.test(plain[k]) || WRAPPERS.has(plain[k]) || (k && WRAPPERS.has(plain[k - 1]) && plain[k].startsWith("-")))) k++; };
    skip();
    let prog = path.basename(plain[k] || ""), rest = plain.slice(k + 1);
    if (prog === "git" && ["rm", "mv"].includes(rest[0])) { prog = rest[0]; rest = rest.slice(1); }
    const files = rest.filter(a => !a.startsWith("-"));
    if (prog === "cd") { if (rest[0] !== "-") dir = abs(dir, rest[0] || HOME); continue; }
    if (prog === "tee") out.push(...files.map(f => abs(dir, f)));
    else if (["cp", "mv", "rsync", "ln", "install"].includes(prog) && files.length) out.push(abs(dir, files.at(-1)));
    else if (["rm", "rmdir", "mkdir", "touch", "truncate", "unlink", "shred"].includes(prog)) out.push(...files.map(f => abs(dir, f)));
    else if (["chmod", "chown", "chgrp"].includes(prog)) out.push(...files.slice(1).map(f => abs(dir, f)));
    else if (prog === "sed" && rest.some(a => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place"))) out.push(...files.map(f => abs(dir, f)));
    else if (prog === "dd") out.push(...rest.filter(a => a.startsWith("of=")).map(a => abs(dir, a.slice(3))));
    else if (["bash", "sh", "zsh", "dash"].includes(prog) && rest.includes("-c")) out.push(...targets(rest[rest.indexOf("-c") + 1] || "", dir));
    else if (INLINE[prog]) {
      const i = rest.findIndex(a => INLINE[prog].includes(a));
      const code = i > -1 ? rest[i + 1] || "" : "";
      if (WRITES.test(code)) out.push(...[...code.matchAll(/(["'`])((?:~|\.\.|\/)[^"'`\s]*)\1/g)].map(m => abs(dir, m[2])));
    }
  }
  return out;
}
const bad = [...new Set(targets(String(ti.command || ""), cwd))].map(refuse).filter(Boolean);
if (bad.length) deny(bad.join("; "));
process.exit(0);
