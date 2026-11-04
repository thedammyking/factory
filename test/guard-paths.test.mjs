// guard-paths.test.mjs — the guard-paths hook spawned as a process and fed PreToolUse input on stdin, against a throwaway
// project with a live run (r1) and its ticket worktree (r1-01), and a run that has ended (r2).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { project, sh } from "./harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugin/scripts/guard-paths.mjs");
// Proven with claude -p on Claude Code 2.1.317 (docs/platform-facts.md, "From guard-paths hook"): a PreToolUse hook fired
// inside the factory plugin's qa subagent gets "agent_type": "factory:qa", with the session's cwd and session_id; the
// orchestrator's own calls carry no agent_type; a `claude -p --agent factory:implementer` child loads the plugin's hooks
// and carries "factory:implementer". The input's cwd follows the session's `cd`s, while CLAUDE_PROJECT_DIR stays put.
// The guard binds only the factory's agents, so the developer's session, SESSION, is free, the orchestrator's included.
const QA = { agent_type: "factory:qa" }, IMPLEMENTER = { agent_type: "factory:implementer" }, PLANNER = { agent_type: "factory:planner" }, SESSION = {};

const p = project({ recipe: { apps: [{ name: "web", type: "web", path: ".", checks: { test: "true" } }], pinned: ["e2e/", "apps/mobile/.maestro"] } });
const WTS = path.join(p.dir, ".factory/worktrees");
// A run worktree at the base tip holding its run dir, as run-state init lays it out, with its state at `stage`.
function run(id, stage) {
  const wt = path.join(WTS, id), runDir = path.join(wt, ".factory/runs", id);
  p.git("worktree", "add", "-q", "--detach", wt);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "state.json"), JSON.stringify({ id, stage }));
  return { wt, runDir };
}
const live = run("r1", "implement"), ended = run("r2", "needs-human");
const ticket = path.join(WTS, "r1-01");
p.git("worktree", "add", "-q", "-b", "factory/r1/01", ticket);
const scratch = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const plain = scratch("factory-plain-");  // a git project without .factory/
sh(plain, "git", ["init", "-q"]);

fs.symlinkSync("/etc", path.join(live.wt, "escape"));            // a directory link that leaves the worktree
fs.symlinkSync("/etc/hosts", path.join(live.wt, "hosts-link"));  // a file link
fs.writeFileSync(path.join(p.dir, "notes.txt"), "");
fs.linkSync(path.join(p.dir, "notes.txt"), path.join(live.wt, "notes-link.txt"));  // a hard link to a file outside

// A hook call, by default the implementer's: cwd is where it last cd'd, its project dir where it started (by default cwd),
// and `env` what the session adds to the hook's environment.
const hook = (cwd, tool_name, tool_input, more = IMPLEMENTER, project = cwd, env = {}) => spawnSync(process.execPath, [SCRIPT], {
  input: JSON.stringify({ session_id: "s-1", hook_event_name: "PreToolUse", cwd, tool_name, tool_input, ...more }),
  env: { ...process.env, FACTORY_CHILD: "", CLAUDE_PROJECT_DIR: project, ...env }, encoding: "utf8",
});
// Write's file_path is always absolute; a relative one here is relative to cwd.
const write = (file, cwd = live.wt, more) => hook(cwd, "Write", { file_path: path.resolve(cwd, file), content: "x" }, more);
const bash = (command, cwd = live.wt, more) => hook(cwd, "Bash", { command }, more);
const allowed = (r) => assert.deepEqual([r.status, r.stderr], [0, ""]);
const denied = (r, why) => { assert.equal(r.status, 2, "denied"); assert.match(r.stderr, why); };

test("hooks.json registers one PreToolUse hook, guard-paths, on the tools that write", () => {
  const { hooks } = JSON.parse(fs.readFileSync(path.join(ROOT, "plugin/hooks/hooks.json"), "utf8"));
  assert.deepEqual(Object.keys(hooks), ["PreToolUse"]);
  assert.equal(hooks.PreToolUse.length, 1);
  const [{ matcher, hooks: [only, ...more] }] = hooks.PreToolUse;
  assert.deepEqual(more, []);
  assert.deepEqual(matcher.split("|").sort(), ["Bash", "Edit", "MultiEdit", "NotebookEdit", "Write"]);
  assert.equal(only.command, 'node "${CLAUDE_PLUGIN_ROOT}/scripts/guard-paths.mjs"');
});

// The drafts' 35 cases. Each runs in the live run's worktree unless it names another: the draft's idle project is the ended
// run's worktree, and its linked worktree the ticket worktree, whose run dir is in the run worktree.
const CASES = [
  // design fix 5: an implementer's replay script wrote a log at the filesystem root
  ["fix 5: deny the offending redirect at the filesystem root", () => bash("node scripts/replay.mjs > /replay.log 2>&1"), 2],
  ["fix 5: deny > /srv.log", () => bash("echo hi > /srv.log"), 2],
  ["fix 5: deny tee ~/x.txt", () => bash("echo x | tee ~/x.txt"), 2],
  ["fix 5: deny cp to /usr/local/bin", () => bash("cp dist/app /usr/local/bin/app"), 2],
  ["fix 5: deny sed -i on the recipe during a run", () => bash("sed -i '' 's/vitest/true/' .factory/setup.json"), 2],
  ["fix 5: deny Write to the recipe during a run", () => write(".factory/setup.json"), 2],
  ["fix 5: deny Write outside the worktree", () => write("/etc/hosts"), 2],
  ["fix 5: deny rm of a CI workflow during a run", () => bash("git rm .github/workflows/ci.yml"), 2],
  ["fix 5: allow an in-repo redirect", () => bash("pnpm test > test.log 2>&1"), 0],
  ["fix 5: allow /dev/null", () => bash("pnpm test 2>/dev/null"), 0],
  ["fix 5: allow /tmp scratch", () => bash("echo x > /tmp/scratch.txt"), 0],
  ["fix 5: allow Write in the repo", () => write("apps/web/src/x.ts"), 0],
  // symlinks
  ["deny Write through a symlinked dir that escapes", () => write("escape/x.conf"), 2],
  ["deny a redirect through a symlinked dir that escapes", () => bash("echo x > escape/x.conf"), 2],
  ["deny Write to a symlink file", () => write("hosts-link"), 2],
  ["deny a redirect to a symlink file", () => bash("echo x >> hosts-link"), 2],
  // escapes and false positives
  ["deny a relative escape", () => bash("echo x > ../../../../../../../../etc/x"), 2],
  ["allow reading the recipe during a run", () => bash("cat .factory/setup.json | grep -c perform"), 0],
  ["allow running a plugin script with 2>&1 during a run", () => bash("node ~/.claude/plugins/cache/factory/scripts/verify.mjs --full 2>&1 | tail -5"), 0],
  ["allow editing the recipe with no active run", () => write(".factory/setup.json", ended.wt), 0],
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
  // the ticket worktree and its run dir
  ["allow Write to the run dir from the ticket worktree", () => write(path.join(live.runDir, "tickets/01-a.md"), ticket), 0],
  ["deny Write to the main checkout's code from the ticket worktree", () => write(path.join(p.dir, "src/x.ts"), ticket), 2],
  ["deny the ticket worktree's recipe during the run", () => write(".factory/setup.json", ticket), 2],
  ["stay out of projects without .factory/", () => write("/etc/hosts", plain), 0],
];
for (const [name, call, status] of CASES) test(name, () => { const r = call(); assert.equal(r.status, status, r.stderr); });

test("a ticket worktree writes itself and its run dir, in the run worktree beside it, and nothing else", () => {
  allowed(write("src/x.ts", ticket));
  allowed(write(path.join(live.runDir, "implementation.md"), ticket));
  allowed(hook(ticket, "Edit", { file_path: path.join(live.runDir, "implementation.md"), old_string: "a", new_string: "b" }));
  denied(write(path.join(live.wt, "src/x.ts"), ticket), /outside/);
  denied(write(path.join(ended.runDir, "notes.md"), ticket), /outside/);
  denied(hook(ticket, "NotebookEdit", { notebook_path: "/etc/x.ipynb", new_source: "" }), /outside/);
});

test("a hard link carries no write out either", () => {
  denied(write("notes-link.txt"), /hard link/);
  denied(bash("echo x >> notes-link.txt"), /hard link/);
});

test("a cd moves no bounds: the current worktree is the one the session started in", () => {
  denied(hook(p.dir, "Bash", { command: "echo x > src/x.ts" }, IMPLEMENTER, ticket), /outside/);
  denied(hook(scratch("factory-cd-"), "Write", { file_path: path.join(live.wt, ".factory/setup.json") }, IMPLEMENTER, live.wt), /locked/);
  denied(hook(path.join(p.dir, ".git"), "Bash", { command: `echo x > ${path.join(live.wt, ".factory/setup.json")}` }, QA, p.dir), /locked/);
});

test("only the factory's agents are bound: during a run, the developer's session still writes where it's asked", () => {
  const settings = path.join(os.homedir(), ".claude/settings.json");
  allowed(write(settings, p.dir, SESSION));
  denied(write(settings, ticket, IMPLEMENTER), /outside/);
});

test("a child run-stage starts, with FACTORY_CHILD=1 in its env, is bound even without an agent_type", () => {
  const settings = { file_path: path.join(os.homedir(), ".claude/settings.json"), content: "x" };
  denied(hook(ticket, "Write", settings, SESSION, ticket, { FACTORY_CHILD: "1" }), /outside/);
  allowed(hook(ticket, "Write", settings, SESSION, ticket));
});

test("during a run only factory:qa writes the recipe's pinned directories, and never the rest of what's locked", () => {
  const pinnedTest = path.join(ticket, "e2e/r1-01-export.spec.ts"), flow = "apps/mobile/.maestro/r1-01-SC-001.yaml";
  allowed(write(pinnedTest, ticket, QA));
  allowed(bash(`echo 'appId: x' > ${flow}`, ticket, QA));
  denied(write(pinnedTest, ticket, IMPLEMENTER), /pinned directory/);
  denied(bash(`echo 'appId: x' > ${flow}`, ticket, IMPLEMENTER), /pinned directory/);
  denied(write(pinnedTest, ticket, PLANNER), /pinned directory/);
  allowed(write(pinnedTest, ticket, { agent_type: "qa" }));  // a project's own agent named qa isn't the factory's, so it isn't bound
  denied(write(pinnedTest, ticket, { agent_type: "factory:not-qa" }), /pinned directory/);  // the exception is exactly factory:qa
  denied(write("E2E/r1-01-export.spec.ts", ticket, IMPLEMENTER), /pinned directory/);  // case-insensitive file systems
  // qa and the other subagents run in the main checkout, the session's cwd, and reach into the ticket worktree from there
  allowed(write(pinnedTest, p.dir, QA));
  denied(write(pinnedTest, p.dir, PLANNER), /pinned directory/);
  denied(write(".factory/setup.json", ticket, QA), /locked/);
  allowed(write(path.join(ended.wt, "e2e/r2-01-old.spec.ts"), ended.wt, IMPLEMENTER));
});

test("during a run the factory's own files, .claude/, CI and lint config are locked, but not the run dir's outputs", () => {
  for (const f of [".factory/config.json", ".factory/touch-rules.json", ".claude/settings.json", ".github/workflows/ci.yml", "apps/web/eslint.config.mjs", ".prettierrc",
    ".github/actions/build/action.yml", ".eslintignore", ".FACTORY/setup.json", ".Claude/settings.json"]) denied(write(f), /locked/);
  allowed(write(path.join(live.runDir, "triage.md")));
  allowed(bash(`echo '- note' >> ${path.join(live.runDir, "run.log")}`, ticket));
  // state.json is run-state's alone: an agent can't end its run, and so unlock everything, by rewriting it
  denied(write(path.join(live.runDir, "state.json"), ticket), /locked/);
  denied(bash(`echo '{"stage":"delivered"}' > ${path.join(live.runDir, "state.json")}`, ticket), /locked/);
  denied(write(path.join(live.runDir, "STATE.json"), ticket), /locked/);
  // a removal or a move takes what it holds with it
  denied(bash("rm -rf .github"), /locked/);
  denied(bash("rm -rf .factory"), /locked/);
  denied(bash(`rm -rf ${live.runDir}`, ticket), /locked/);
  denied(bash("mv .factory/setup.json /tmp/setup.json"), /locked/);
  denied(bash("rm -rf e2e", ticket, IMPLEMENTER), /pinned directory/);
  allowed(bash(`rm -rf ${path.join(live.runDir, "tickets")} && mv a.ts b.ts`));
  allowed(bash("sed -i '' 's/a/b/' src/x.ts"));
  // a subagent, in the main checkout, writes the run dir but not its state; the main checkout itself is never a run's
  // workspace, so its own recipe isn't locked
  allowed(write(path.join(live.runDir, "spec.md"), p.dir, PLANNER));
  denied(write(path.join(live.runDir, "state.json"), p.dir, PLANNER), /locked/);
  allowed(write(".factory/setup.json", p.dir));
  allowed(write(".claude/settings.json", ended.wt));
});

test("reads and script calls are never denied, whatever a heredoc body says", () => {
  allowed(hook(live.wt, "Read", { file_path: "/etc/hosts" }));
  allowed(hook(live.wt, "Grep", { pattern: "x", path: "/etc" }));
  allowed(bash("cat /etc/hosts .factory/setup.json | grep -c localhost > /dev/null"));
  const RS = path.join(ROOT, "plugin/scripts/run-state.mjs");
  allowed(bash(`node ${RS} set stage needs-human --run r1`, p.dir));
  // a heredoc body is data, whatever it says
  allowed(bash(`node ${RS} init <<'FACTORY_REQUEST'\nExport fails: cp dist/app /usr/local/bin/app > /srv.log\nDon't touch CI\nFACTORY_REQUEST`, p.dir));
  denied(bash("cat > /etc/motd <<EOF\nhello\nEOF"), /outside/);
  denied(bash("cat <<-'EOF' > notes.md\n\tok\n\tEOF\necho x > /srv.log"), /outside/);  // after the body, commands again
});

test("$(…) and backticks are checked inside double quotes too, and so are inline code's relative paths", () => {
  denied(bash('echo "$(touch /etc/x)"'), /outside/);
  denied(bash('echo "today: `date > /srv/today`"'), /outside/);
  denied(bash("echo `touch /etc/x`"), /outside/);
  denied(bash('out="$(cd /etc && echo "$(touch x)")"'), /outside/);
  allowed(bash('v="$(git rev-parse HEAD)"; echo "$v" > head.txt'));
  denied(bash(`node -e "require('fs').writeFileSync('.factory/setup.json', '{}')"`), /locked/);
  allowed(bash(`node -e "require('fs').writeFileSync('list.txt', require('fs').readdirSync('e2e').join())"`));
});

test("other shell forms of a write: in-place perl, bash -lc, eval, $HOME, a continued line, arithmetic", () => {
  denied(bash("perl -pi -e 's/vitest/true/' .factory/setup.json"), /locked/);
  denied(bash("bash -lc 'echo hi > /etc/x'"), /outside/);
  denied(bash('eval "echo hi > /etc/x"'), /outside/);
  denied(bash('echo x >> "$HOME/.zshrc"'), /outside/);
  denied(bash("echo x > \\\n/etc/x"), /outside/);
  denied(bash("echo $((1<<2))\necho x > /etc/x"), /outside/);  // an arithmetic << is no heredoc
});

test("a cd inside a subshell or a substitution stays there", () => {
  allowed(bash('cd "$(git rev-parse --show-toplevel)" && pnpm test > test.log'));
  allowed(bash('X="$(cd .. && pwd)"; echo hi > out.log'));
  allowed(bash("(cd ~ && ls); echo hi > out.log"));
  denied(bash("(cd /etc && touch x)"), /outside/);
});

test("does nothing in a project without .factory/, or outside git", () => {
  allowed(bash("echo x > /etc/x", plain));
  allowed(write("/etc/hosts", scratch("factory-nogit-")));
});
