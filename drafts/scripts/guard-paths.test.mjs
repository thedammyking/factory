#!/usr/bin/env node
// guard-paths.test.mjs — the fix-5 cases plus the symlink and false-positive cases. `node guard-paths.test.mjs`; exit 1 on a miss.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const guard = path.join(path.dirname(fileURLToPath(import.meta.url)), "guard-paths.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
fs.mkdirSync(path.join(root, ".factory/runs"), { recursive: true });
fs.writeFileSync(path.join(root, ".factory/setup.json"), "{}");
fs.symlinkSync("/etc", path.join(root, "escape"));                    // a directory link that leaves the worktree
fs.symlinkSync("/etc/hosts", path.join(root, "hosts-link"));          // a file link
const idle = fs.mkdtempSync(path.join(os.tmpdir(), "guard-idle-"));   // a project with no active run
fs.mkdirSync(path.join(idle, ".factory"), { recursive: true });

const run = (cwd, tool_name, tool_input) => spawnSync("node", [guard], { input: JSON.stringify({ cwd, tool_name, tool_input }), encoding: "utf8" }).status;
const bash = (command, cwd = root) => run(cwd, "Bash", { command });
const write = (file_path, cwd = root) => run(cwd, "Write", { file_path });
const cases = [
  // the twelve from dry-run fix 5
  ["deny the offending redirect at the filesystem root", () => bash("node scripts/replay.mjs > /replay.log 2>&1"), 2],
  ["deny > /srv.log", () => bash("echo hi > /srv.log"), 2],
  ["deny tee ~/x.txt", () => bash("echo x | tee ~/x.txt"), 2],
  ["deny cp to /usr/local/bin", () => bash("cp dist/app /usr/local/bin/app"), 2],
  ["deny sed -i on the recipe during a run", () => bash("sed -i '' 's/vitest/true/' .factory/setup.json"), 2],
  ["deny Write to the recipe during a run", () => write(".factory/setup.json"), 2],
  ["deny Write outside the worktree", () => write("/etc/hosts"), 2],
  ["deny rm of a CI workflow during a run", () => bash("git rm .github/workflows/ci.yml"), 2],
  ["allow an in-repo redirect", () => bash("pnpm test > test.log 2>&1"), 0],
  ["allow /dev/null", () => bash("pnpm test 2>/dev/null"), 0],
  ["allow /tmp scratch", () => bash("echo x > /tmp/scratch.txt"), 0],
  ["allow Write in the repo", () => write("apps/web/src/x.ts"), 0],
  // symlinks
  ["deny Write through a symlinked dir that escapes", () => write("escape/x.conf"), 2],
  ["deny a redirect through a symlinked dir that escapes", () => bash("echo x > escape/x.conf"), 2],
  ["deny Write to a symlink file", () => write("hosts-link"), 2],
  ["deny a redirect to a symlink file", () => bash("echo x >> hosts-link"), 2],
  // escapes and false positives
  ["deny a relative escape", () => bash("echo x > ../../../../../../../../etc/x"), 2],
  ["allow reading the recipe during a run", () => bash("cat .factory/setup.json | grep -c perform"), 0],
  ["allow running a plugin script with 2>&1 during a run", () => bash("node ~/.claude/plugins/cache/factory/scripts/verify.mjs --full 2>&1 | tail -5"), 0],
  ["allow editing the recipe with no active run", () => write(".factory/setup.json", idle), 0],
];
fs.writeFileSync(path.join(root, ".factory/runs/ACTIVE"), "r\n");
let failed = 0;
for (const [name, fn, want] of cases) { const got = fn(); if (got !== want) failed++; console.log(`${got === want ? "ok  " : "FAIL"} ${name} (exit ${got}, want ${want})`); }
fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(idle, { recursive: true, force: true });
console.log(`${cases.length - failed}/${cases.length} passed`); process.exit(failed ? 1 : 0);
