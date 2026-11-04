#!/usr/bin/env node
// run-stage.mjs — the implement stage of one ticket, the only stage that runs outside the orchestrator's session: an
// implementer child (`claude -p --agent factory:implementer`) in the ticket's own worktree, judged by verify, then merged
// into the run branch. Takes --run <id>. Each command's last line is its verdict, `<WORD> <NN>: <why>`.
//   run-stage.mjs implement <NN> -> one attempt at ticket NN, whose plan is ready. It dispatches implement:NN through
//      run-state, whose BUDGET refusal passes through (exit 4). The first attempt cuts .factory/worktrees/<run>-NN/ on
//      factory/<run>/NN at the SHA that dispatch recorded and runs the recipe's setup there. The child runs in that
//      worktree with --max-turns, acceptEdits, no permission prompts, an --allowedTools list built from the recipe, no
//      MCP server and the run dir added; its PID, session id and stream-json log (logs/ in the run dir) are recorded on
//      the dispatch. Below the last round that `run-state round implement:NN` counted, it resumes the ticket's last
//      child session with what its last attempt left to fix; at the last round (caps.implement_rounds, 3) it starts a
//      fresh child on models.implement_escalated, told that a prior implementer tried twice. When the child exits,
//      verify --full judges the ticket's worktree (unless the child stopped BLOCKED or NEEDS_CONTEXT), and:
//        MERGE      DONE with no concern, and the evidence green at the ticket's HEAD
//        ROUND      a red introduced or incomplete, a report with no status line (INCOMPLETE), or a concern to fix
//        AMEND      BLOCKED: bad_plan: the ticket's commits are reset away, and the planner amends the plan, once
//        RESEARCH   NEEDS_CONTEXT: one researcher dispatch answers its question in tickets/NN/context.md
//        ATTENTION  for the human: a red inherited or environment, BLOCKED: intent_gap or environment, a bad plan after
//                   the amendment, NEEDS_CONTEXT after the researcher's answer, no evidence, or a setup that failed
//   run-stage.mjs merge <NN> -> after MERGE: merges factory/<run>/NN into the run branch, runs verify --full at the new
//      head, then removes the ticket's worktree and branch. MERGED (the ticket marked done) when the run head is green;
//      ATTENTION when it's red, or on a conflict, which is aborted and leaves everything as it was.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readJson, git, gitError, runContext, runEnv, digest, ticketWorktree, ticketBranch } from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url)), PLUGIN = path.dirname(HERE);
const [cmd, n] = process.argv.slice(2);
if (!["implement", "merge"].includes(cmd) || !/^\d{2}$/.test(n || "")) { console.error("run-stage: usage: run-stage.mjs implement | merge <NN> --run <id>"); process.exit(2); }
const ctx = runContext(), stage = `implement:${n}`;
const wt = ticketWorktree(ctx.MAIN, ctx.id, n), branch = ticketBranch(ctx.id, n), dir = path.join(ctx.runDir, "tickets", n);
const IMPL = path.join(dir, "implementation.md"), EVIDENCE = path.join(dir, "evidence.json");
// the child's --max-turns: the implementer's own maxTurns
const MAX_TURNS = fs.readFileSync(path.join(PLUGIN, "agents", "implementer.md"), "utf8").match(/^maxTurns:[ \t]*(\d+)/m)[1];
const INSTALL = { npm: ["ci", "install"], pnpm: ["install", "add"], yarn: ["install", "add"], bun: ["install", "add"] };  // a package manager's install and add
// git as the implementer uses it: never push, fetch, rebase or switch branches
const GIT = ["status", "diff", "log", "show", "add", "rm", "mv", "restore", "commit"];
const config = readJson(path.join(ctx.MAIN, ".factory", "config.json"), {});
const node = (script, args, opts) => spawnSync(process.execPath, [path.join(HERE, script), ...args], { encoding: "utf8", ...opts });
const runState = (...args) => node("run-state.mjs", [...args, "--run", ctx.id]);
const told = (r) => { if (r.status) console.log(`${r.stdout}${r.stderr}`.trim()); return r; };  // a run-state refusal, printed
const state = () => readJson(ctx.state);
const say = (word, why) => { console.log(`${word} ${n}: ${why}`); process.exit(0); };
const die = (msg) => { console.error(`run-stage: ${msg}`); process.exit(2); };
const head = () => fs.existsSync(wt) ? git(wt, "rev-parse", "HEAD") : null;

// The implementer's report: its last status line (null when it has none, an INCOMPLETE attempt), cause and concerns.
function report() {
  const text = fs.existsSync(IMPL) ? fs.readFileSync(IMPL, "utf8") : "", last = (re) => [...text.matchAll(re)].at(-1)?.[1];
  const concerns = (last(/^concerns:[ \t]*\n((?:[ \t]*- .*(?:\n|$))*)/gm) || "").split("\n").map((l) => l.trim()).filter((l) => l && l !== "- none");
  return { status: last(/^status:[ \t]*(DONE_WITH_CONCERNS|DONE|BLOCKED|NEEDS_CONTEXT)[ \t]*$/gm) || null, cause: last(/^blocked_cause:[ \t]*(\w+)/gm), concerns };
}
// What the ticket's files say comes next, as [word, why]. A plan is amended and a question researched once per ticket.
function verdict(s) {
  const { status, cause, concerns } = report(), first = s.dispatches.findIndex((d) => d.stage === stage);
  if (status === "BLOCKED" && cause === "bad_plan") return s.dispatches.some((d, i) => i > first && d.stage === `plan:${n}`)
    ? ["ATTENTION", "BLOCKED: bad_plan again, after the planner's one amendment"] : ["AMEND", "BLOCKED: bad_plan, so the ticket's commits are reset and the planner amends the plan"];
  if (status === "BLOCKED") return ["ATTENTION", cause === "intent_gap" ? "BLOCKED: intent_gap, the spec leaves open what to build" : `BLOCKED: ${cause || "no cause given"}, see implementation.md`];
  // a researcher dispatched before the latest attempt has had its one go; one dispatched since is answering this question
  const asked = s.dispatches.findIndex((d) => d.stage === `context:${n}`);
  if (status === "NEEDS_CONTEXT") return asked > -1 && asked < s.dispatches.findLastIndex((d) => d.stage === stage)
    ? ["ATTENTION", "NEEDS_CONTEXT again, after its one researcher dispatch"] : ["RESEARCH", `NEEDS_CONTEXT, so one researcher dispatch answers its question in ${path.join(dir, "context.md")}`];
  const ev = readJson(EVIDENCE), sha = head();
  if (!ev || ev.sha !== sha) return ["ATTENTION", `verify --full left no evidence at the ticket's HEAD ${sha?.slice(0, 7)}`];
  if (!ev.green) return [["inherited", "environment"].includes(ev.red_cause) ? "ATTENTION" : "ROUND", `verify --full is red at ${sha.slice(0, 7)}, red_cause ${ev.red_cause}`];
  if (!status) return ["ROUND", "implementation.md has no status line, so the attempt is INCOMPLETE"];
  if (status === "DONE_WITH_CONCERNS" || concerns.length) return ["ROUND", "the implementer named a concern, which is fixed before the next ticket"];
  return ["MERGE", `DONE, and verify --full is green at ${sha.slice(0, 7)}`];
}

if (cmd === "merge") {
  const s = state(), [word, why] = verdict(s);
  if (word !== "MERGE") die(`ticket ${n} isn't ready to merge: ${why}`);
  try { git(ctx.worktree, "merge", "-q", "--no-edit", branch); } catch (e) {
    const files = git(ctx.worktree, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
    try { git(ctx.worktree, "merge", "--abort"); } catch {}
    say("ATTENTION", `merging ${branch} into ${s.branch} conflicts${files.length ? ` in ${files.join(", ")}` : `: ${gitError(e)}`}, so the merge was aborted`);
  }
  const v = node("verify.mjs", ["--full", "--run", ctx.id], { cwd: ctx.MAIN }), sha = git(ctx.worktree, "rev-parse", "HEAD");
  console.log(v.stdout.split("\n")[0]);
  // The branch is in the run branch now, which -d can't see from the main checkout. --force: the worktree's ignored files,
  // such as installed dependencies, go with it.
  try { git(ctx.MAIN, "worktree", "remove", "--force", wt); git(ctx.MAIN, "branch", "-q", "-D", branch); } catch (e) { console.log(`ticket worktree kept: ${gitError(e)}`); }
  const ev = readJson(path.join(ctx.runDir, "evidence.json"));
  if (!ev?.green || ev.sha !== sha) say("ATTENTION", `verify --full is red at the run head ${sha.slice(0, 7)} after merging two green sides, red_cause ${ev?.red_cause}`);
  if (told(runState("ticket", n, "done")).status) say("ATTENTION", `merged at ${sha.slice(0, 7)} and green, but ticket ${n} couldn't be marked done`);
  say("MERGED", `at ${sha.slice(0, 7)} on ${s.branch}, where verify --full is green`);
}

const ticket = fs.readdirSync(path.join(ctx.runDir, "tickets")).find((f) => f.startsWith(`${n}-`) && f.endsWith(".md"))?.slice(0, -3);
if (!ticket) die(`no ticket ${n} in ${ctx.id}`);
if (!/^status:[ \t]*ready[ \t]*$/m.test(fs.existsSync(path.join(dir, "plan.md")) ? fs.readFileSync(path.join(dir, "plan.md"), "utf8") : "")) die(`ticket ${n}'s plan isn't ready`);
const before = state(), { n: round = 0, cap } = before.rounds?.[stage] || {}, atLast = round > 0 && round >= cap;
const attempts = before.dispatches.filter((d) => d.stage === stage).length;
// A new plan gets a fresh child; so does the last round `run-state round` counted. Any other attempt resumes the ticket's
// last child session, told what the last attempt left, read before the dispatch moves its report aside as
// implementation.round<attempts>.md.
const planned = before.dispatches.findLastIndex((d) => d.stage === `plan:${n}`);
const last = before.dispatches.slice(planned + 1).filter((d) => d.stage === stage && d.session).at(-1);
const escalated = !!last && atLast && (last.round || 0) < round, fresh = !last || escalated;
const [was] = attempts ? verdict(before) : [], { status: wasStatus } = report();
const ev = readJson(EVIDENCE), moved = fs.existsSync(IMPL) && path.join(dir, `implementation.round${attempts}.md`);

const d = runState("dispatch", stage);
process.stdout.write(d.stdout);
if (d.status) { process.stderr.write(d.stderr); process.exit(d.status); }
const cut = state().dispatches.find((x) => x.stage === stage).sha;
if (!fs.existsSync(wt)) {
  try { git(ctx.MAIN, "worktree", "add", "-q", "-b", branch, wt, cut); } catch (e) { say("ATTENTION", `the ticket's worktree couldn't be made: ${gitError(e)}`); }
  const setup = readJson(path.join(wt, ".factory", "setup.json"), {}).setup;
  if (setup) {
    const log = path.join(ctx.runDir, "logs", `setup-${n}.log`);
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const fd = fs.openSync(log, "w"), r = spawnSync("bash", ["-c", setup], { cwd: wt, env: runEnv(ctx.MAIN), stdio: ["ignore", fd, fd], timeout: 10 * 60_000 });
    fs.closeSync(fd);
    if (r.status !== 0) {
      // Nothing is committed yet, so the next attempt cuts the worktree again and reruns the setup.
      git(ctx.MAIN, "worktree", "remove", "--force", wt); git(ctx.MAIN, "branch", "-q", "-D", branch);
      console.log(digest(fs.readFileSync(log, "utf8"), log));
      say("ATTENTION", "the recipe's setup failed in the ticket's worktree");
    }
  }
}

// The child may run each check's program, git as it needs it, the package manager's install and add, and verify. Reads
// and edits in its worktree and the run dir need no rule under acceptEdits.
// ponytail: a check's program is its first word, so a check written `cd web && pnpm lint` allows only cd and names no
// package manager; read the package manager from the recipe once setup records it.
const recipe = readJson(path.join(wt, ".factory", "setup.json"), {});
const program = (c) => String(c ?? "").trim().split(/\s+/).find((w) => !/^[A-Za-z_]\w*=/.test(w));  // past any NAME=value
const programs = (recipe.apps || []).flatMap((a) => Object.values(a.checks || {}).map((c) => program(typeof c === "string" ? c : c?.cmd))).filter(Boolean);
const allowed = [...new Set([...programs.map((p) => `Bash(${p}:*)`), ...GIT.map((c) => `Bash(git ${c}:*)`),
  ...[...programs, program(recipe.setup)].filter((p) => INSTALL[p]).flatMap((p) => INSTALL[p].map((c) => `Bash(${p} ${c}:*)`)),
  `Bash(node ${path.join(HERE, "verify.mjs")}:*)`])];

// What the child is told: the plan for a fresh child, else what its last attempt left to do.
function message() {
  const again = moved ? ` Then write ${IMPL} again from the top: the last one is now ${moved}.` : "";
  const tries = round - 1 === 2 ? "twice" : `${round - 1} times`;
  if (escalated) return `A prior implementer has worked on this ticket and tried ${tries} to fix it; you own it now. Its commits stay on this branch. `
    + `Read the plan, then its last report${moved ? ` (${moved})` : ""} and the last evidence (${EVIDENCE}), and carry on from the code as it is.`;
  if (fresh) return "Implement the plan.";
  if (was === "ROUND" && ev && !ev.green && ev.sha === head()) return `verify --full is red at ${ev.sha.slice(0, 7)}, red_cause ${ev.red_cause}: ${EVIDENCE} has each failing check's digest and log. Fix what it shows.${again}`;
  if (was === "ROUND" && !wasStatus) return `Your last turn ended before implementation.md had its status line. Carry on with the plan.${again}`;
  if (was === "ROUND") return `Fix each concern under concerns: in ${moved || IMPL}, or say there why it needs no fix.${again}`;
  if (was === "RESEARCH") return `The answer to your question is in ${path.join(dir, "context.md")}. Carry on with the plan.${again}`;
  return `Carry on with the plan where you left off.${again}`;
}
const lines = [`run_dir: ${ctx.runDir}`, `worktree: ${wt}`, `ticket: ${ticket}`, `plan: ${path.join(dir, "plan.md")}`, `implementation: ${IMPL}`];
const session = fresh ? crypto.randomUUID() : last.session;
const model = atLast ? config.models?.implement_escalated || "opus" : config.models?.implement || "sonnet";
const log = path.join(ctx.runDir, "logs", `implement-${n}.${attempts + 1}.jsonl`);
fs.mkdirSync(path.dirname(log), { recursive: true });
const fd = fs.openSync(log, "w");
const child = spawn("claude", ["-p", "--agent", "factory:implementer", "--plugin-dir", PLUGIN, "--model", model, "--max-turns", String(MAX_TURNS),
  "--permission-mode", "acceptEdits", "--permission-prompts", "none", "--allowedTools", allowed.join(","), "--strict-mcp-config",
  "--add-dir", ctx.runDir, "--output-format", "stream-json", "--verbose", ...(fresh ? ["--session-id", session] : ["--resume", session])],
  { cwd: wt, stdio: ["pipe", fd, fd] });
fs.closeSync(fd);
const exited = new Promise((resolve) => { child.on("error", resolve); child.on("close", () => resolve(null)); });
if (!child.pid) say("ATTENTION", `claude couldn't start: ${(await exited)?.message}`);
child.stdin.end(fresh ? `${lines.join("\n")}\n\n${message()}\n` : `${message()}\n`);
told(runState("dispatch", stage, "--log", log, "--pid", String(child.pid), "--session", session));
await exited;

// The child is judged by what it left, never by its exit code: a child out of turns exits 1 (docs/platform-facts.md).
// What Claude Code denied it is copied into its report from its result, so a stop names what to allow even when the
// child ran out of turns before writing its own denied: list.
const denials = fs.readFileSync(log, "utf8").split("\n").flatMap((l) => { try { const e = JSON.parse(l); return e.type === "result" ? e.permission_denials || [] : []; } catch { return []; } });
if (denials.length) fs.appendFileSync(IMPL, `\nDenied, as the child's result records it:\n${denials.map((x) => `- \`${x.tool_name}: ${x.tool_input?.command ?? x.tool_input?.file_path ?? JSON.stringify(x.tool_input)}\``).join("\n")}\n`);
const { status } = report();
if (!["BLOCKED", "NEEDS_CONTEXT"].includes(status)) console.log(node("verify.mjs", ["--full", "--run", ctx.id], { cwd: wt }).stdout.split("\n")[0]);
if (status) told(runState("done", stage));
const [word, why] = verdict(state());
if (word === "AMEND") { git(wt, "reset", "-q", "--hard", cut); git(wt, "clean", "-qfd"); }
say(word, why);
