#!/usr/bin/env node
// guard-paths.test.mjs — the fix-5 cases, symlinks, false positives, the parser's cases and linked worktrees. `node guard-paths.test.mjs`; exit 1 on a miss.
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
const plain = fs.mkdtempSync(path.join(os.tmpdir(), "guard-plain-")); // not a factory project
// a git project whose run lives in the main checkout while the agent works in a linked worktree
const main = fs.mkdtempSync(path.join(os.tmpdir(), "guard-main-"));
const g = (...a) => spawnSync("git", ["-C", main, ...a], { encoding: "utf8" });
g("init", "-q"); fs.mkdirSync(path.join(main, ".factory/runs/r"), { recursive: true });
fs.writeFileSync(path.join(main, ".factory/setup.json"), "{}"); fs.writeFileSync(path.join(main, ".gitignore"), ".factory/runs/\n");
g("add", "."); g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
const linked = path.join(main, "wt"); g("worktree", "add", "-q", "-b", "ticket", linked);
fs.writeFileSync(path.join(main, ".factory/runs/ACTIVE"), JSON.stringify({ id: "r" }));

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
  // the parser: cd, quotes, subshells, inline scripts
  ["deny cd out then a relative write", () => bash("cd /etc && touch x"), 2],
  ["deny cd .. twice then a redirect", () => bash("cd .. && cd .. && echo x > y"), 2],
  ["deny a write inside $(...)", () => bash("echo $(cd /etc && touch x)"), 2],
  ["deny sed -i with a quoted ; on a file outside", () => bash("sed -i 's/a;b/c/' ../x"), 2],
  ["allow a quoted > that is not a redirect", () => bash("echo 'a > /etc/x' && echo \"b >> /srv/y\""), 0],
  ["deny bash -c that redirects outside", () => bash("bash -c 'echo hi > /etc/x'"), 2],
  ["deny node -e that writes outside", () => bash(`node -e "require('fs').writeFileSync('/etc/x', '')"`), 2],
  ["deny python -c that writes outside", () => bash(`python3 -c "open('/etc/x', 'w').write('')"`), 2],
  ["allow node -e that only reads outside", () => bash(`node -e "console.log(require('fs').readFileSync('/etc/hosts', 'utf8'))"`), 0],
  ["deny >& file (stdout and stderr to a file)", () => bash("make >& /srv/build.log"), 2],
  ["deny git mv into a workflow during a run", () => bash("git mv ci.yml .github/workflows/ci.yml"), 2],
  // linked worktrees: the run dir is in the main checkout, ACTIVE there protects the worktree's recipe
  ["allow Write to the run dir from a linked worktree", () => write(path.join(main, ".factory/runs/r/tickets/01-a.md"), linked), 0],
  ["deny Write to the main checkout's code from a linked worktree", () => write(path.join(main, "src/x.ts"), linked), 2],
  ["deny the linked worktree's recipe during the run", () => write(".factory/setup.json", linked), 2],
  ["stay out of projects without .factory/", () => write("/etc/hosts", plain), 0],
];
fs.writeFileSync(path.join(root, ".factory/runs/ACTIVE"), "r\n");
let failed = 0;
for (const [name, fn, want] of cases) { const got = fn(); if (got !== want) failed++; console.log(`${got === want ? "ok  " : "FAIL"} ${name} (exit ${got}, want ${want})`); }
for (const d of [root, idle, plain, main]) fs.rmSync(d, { recursive: true, force: true });
console.log(`${cases.length - failed}/${cases.length} passed`); process.exit(failed ? 1 : 0);
