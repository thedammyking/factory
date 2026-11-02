#!/usr/bin/env node
// guard-paths.mjs — PreToolUse hook. Reads the hook JSON on stdin; exit 2 (+ stderr) denies the tool call, exit 0 allows.
// Rules: Write/Edit/MultiEdit/NotebookEdit must target a path inside the project root (the worktree);
//        Bash must not redirect, tee, cp/mv/ln into, or rm/mkdir/touch/chmod/sed -i paths outside the root. Reads anywhere are fine.
//        /dev/ and /tmp/ are allowed. Paths are compared after resolving symlinks, and a write whose target is itself a symlink
//        is refused, so a link inside the worktree cannot carry a write outside it.
//        During an active run, protected files (recipe, scripts, CI, lint config, .claude/) may not be written at all.
// ponytail: shell parsing is regex-based (no quotes-aware tokenizer, no `cd` tracking, no interpreter one-liners); the
//           Write/Edit rule is the real boundary, the Bash rule catches the common forms.
import fs from "node:fs";
import path from "node:path";

const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
const root = path.resolve(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
const tool = input.tool_name || "";
const ti = input.tool_input || {};
const deny = (msg) => { process.stderr.write(`guard-paths: ${msg}\n`); process.exit(2); };
const runActive = (() => { try { return fs.existsSync(path.join(root, ".factory/runs/ACTIVE")); } catch { return false; } })();
const PROTECTED = /(^|\/)(\.factory\/setup\.json|\.factory\/scripts\/|\.factory\/agents\/|\.claude\/|\.github\/workflows\/|eslint\.config\.|\.eslintrc|prettier\.config|\.prettierrc|biome\.json)/;

const realRoot = fs.realpathSync(root);
const TMP = fs.realpathSync("/tmp");
const abs = (p) => path.resolve(root, p.replace(/^~(?=$|\/)/, process.env.HOME || "~"));
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
// realpath of the longest existing ancestor + the missing tail; null when that ancestor is a dangling link
const real = (p) => { let a = abs(p); const tail = []; while (!exists(a) && path.dirname(a) !== a) { tail.unshift(path.basename(a)); a = path.dirname(a); }
  try { return path.join(fs.realpathSync(a), ...tail); } catch { return null; } };
const under = (r, dir) => r === dir || r.startsWith(dir + path.sep);
const isLink = (p) => { try { return fs.lstatSync(abs(p)).isSymbolicLink(); } catch { return false; } };
// why a write to p is refused, or null
const refuse = (p) => {
  const r = real(p);
  if (r && under(r, "/dev")) return null;
  if (isLink(p)) return `write through a symlink refused: ${p}`;
  if (!r || !(under(r, realRoot) || under(r, TMP))) return `write outside the worktree refused: ${p}`;
  if (runActive && under(r, realRoot) && PROTECTED.test(path.relative(realRoot, r))) return `protected during an active run: ${p}`;
  return null;
};

if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
  const p = ti.file_path || ti.notebook_path || "";
  const why = p && refuse(p);
  if (why) deny(why);
  process.exit(0);
}
if (tool === "Bash") {
  const cmd = String(ti.command || "");
  const targets = [];
  // redirects (not >&N); then the write arguments of tee, cp/mv/rsync/ln (destination), rm/mkdir/touch/chmod/chown/truncate, sed -i
  for (const m of cmd.matchAll(/(?:^|[^<>])>{1,2}\s*(["']?)([^\s"'|;&<>()]+)\1/g)) targets.push(m[2]);
  const words = (s) => s.trim().split(/\s+/).map(w => w.replace(/^["']|["']$/g, "")).filter(w => w && !w.startsWith("-"));
  for (const m of cmd.matchAll(/\btee\b([^|;&<>]*)/g)) targets.push(...words(m[1]));
  for (const m of cmd.matchAll(/\b(?:cp|mv|rsync|ln)\b([^|;&<>]*)/g)) targets.push(...words(m[1]).slice(-1));
  for (const m of cmd.matchAll(/\b(?:rm|rmdir|mkdir|touch|chmod|chown|truncate)\b([^|;&<>]*)/g)) targets.push(...words(m[1]));
  for (const m of cmd.matchAll(/\bsed\b(?=[^|;&<>]*\s-i)([^|;&<>]*)/g)) targets.push(...words(m[1]));
  const bad = [...new Set(targets)].map(refuse).filter(Boolean);
  if (bad.length) deny(bad.join("; "));
  process.exit(0);
}
process.exit(0);
