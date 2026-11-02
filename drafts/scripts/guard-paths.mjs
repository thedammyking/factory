#!/usr/bin/env node
// guard-paths.mjs — PreToolUse hook. Reads the hook JSON on stdin; exit 2 (+ stderr) denies the tool call, exit 0 allows.
// Rules: Write/Edit/MultiEdit/NotebookEdit must target a path inside the project root (the worktree);
//        Bash must not redirect, tee, cp/mv into, or rm paths outside the root (absolute paths or ~). Reads anywhere are fine.
//        During an active run, protected files (recipe, scripts, CI, lint config, .claude/) may not be edited at all.
import fs from "node:fs";
import path from "node:path";

const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
const root = path.resolve(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
const tool = input.tool_name || "";
const ti = input.tool_input || {};
const inside = (p) => { const r = path.resolve(root, p.replace(/^~(?=$|\/)/, process.env.HOME || "~")); return r === root || r.startsWith(root + path.sep); };
const deny = (msg) => { process.stderr.write(`guard-paths: ${msg}\n`); process.exit(2); };
const runActive = (() => { try { return fs.existsSync(path.join(root, ".factory/runs/ACTIVE")); } catch { return false; } })();
const PROTECTED = /(^|\/)(\.factory\/setup\.json|\.factory\/scripts\/|\.factory\/agents\/|\.claude\/|\.github\/workflows\/|eslint\.config\.|\.eslintrc|prettier\.config|\.prettierrc|biome\.json)/;

if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
  const p = ti.file_path || ti.notebook_path || "";
  if (!p) process.exit(0);
  if (!inside(p)) deny(`write outside the worktree refused: ${p}`);
  if (runActive && PROTECTED.test(path.relative(root, path.resolve(root, p)))) deny(`protected during an active run: ${p}`);
  process.exit(0);
}
if (tool === "Bash") {
  const cmd = String(ti.command || "");
  // redirects / tee / cp / mv / rm / mkdir targets that are absolute or home-relative
  const targets = [];
  for (const m of cmd.matchAll(/(?:^|[^<>])>{1,2}\s*(["']?)((?:\/|~\/)[^\s"'|;&]*)\1/g)) targets.push(m[2]);
  for (const m of cmd.matchAll(/\btee\s+(?:-a\s+)?(["']?)((?:\/|~\/)[^\s"'|;&]*)\1/g)) targets.push(m[2]);
  for (const m of cmd.matchAll(/\b(?:cp|mv|rsync)\b[^|;&]*\s(["']?)((?:\/|~\/)[^\s"'|;&]*)\1\s*(?:[;&|]|$)/g)) targets.push(m[2]);
  for (const m of cmd.matchAll(/\b(?:rm|rmdir|mkdir|touch|chmod|chown)\b[^|;&]*?\s(["']?)((?:\/|~\/)[^\s"'|;&]*)\1/g)) targets.push(m[2]);
  const bad = targets.filter(t => !t.startsWith("/dev/") && !t.startsWith("/tmp/") && !inside(t));
  if (bad.length) deny(`command writes outside the worktree: ${bad.join(", ")}`);
  if (runActive) {
    const prot = [...cmd.matchAll(/[\w./-]+/g)].map(m => m[0]).filter(t => PROTECTED.test(t) && /(>|sed\s+-i|tee|cp|mv|rm|chmod)/.test(cmd));
    if (prot.length) deny(`protected during an active run: ${[...new Set(prot)].join(", ")}`);
  }
  process.exit(0);
}
process.exit(0);
