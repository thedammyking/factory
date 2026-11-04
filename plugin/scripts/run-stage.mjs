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
//      fresh child on models.implement_escalated, told that a prior implementer tried twice. A session whose child was
//      cut off before it printed a message or a result can't be resumed, so a fresh child is pointed at the git log
//      since that attempt's dispatch and at its report. When the child exits, verify --full judges the ticket's
//      worktree (unless the child stopped BLOCKED or NEEDS_CONTEXT, or at the usage limit), and:
//        SUSPENDED  the child stopped at the usage limit, which costs no round: nothing is judged until it carries on
//        MERGE      DONE with no concern, and the evidence green at the ticket's HEAD, after qa's walk
//        QA         for qa:NN, which costs no round: DONE and green, but qa hasn't walked the ticket since this attempt
//                   (when the recipe has an app with a dev command), or a red only in pinned tests it hasn't ruled on;
//                   never on a docs, refactor or maintenance oneshot
//        ROUND      a red introduced or incomplete, a report with no status line (INCOMPLETE), or a concern to fix
//        AMEND      BLOCKED: bad_plan: the ticket's commits are reset away, and the planner amends the plan, once
//        RESEARCH   NEEDS_CONTEXT: one researcher dispatch answers its question in tickets/NN/context.md
//        ATTENTION  for the human: a red inherited or environment, BLOCKED: intent_gap or environment, a bad plan after
//                   the amendment, NEEDS_CONTEXT after the researcher's answer, no evidence, or a setup that failed
//   run-stage.mjs merge <NN> -> after MERGE: merges factory/<run>/NN into the run branch, runs verify --full at the new
//      head, then takes the ticket's apps and database down (run-apps down --drop there) and removes its worktree and
//      branch. MERGED (the ticket marked done) when the run head is green;
//      ATTENTION when it's red, or on a conflict, which is aborted and leaves everything as it was. Merges of one run
//      wait on each other, and none goes into a run head whose evidence is red.
//   run-stage.mjs verify <NN> -> after qa:NN is done: verify --full judges the ticket's worktree again, qa's pinned tests
//      included, and the verdict is as implement's. A resume that finds implement:NN done runs it too.
//   run-stage.mjs review-fix -> one review fix round, once `run-state round review` has counted it and findings.json's
//      disposition is fix. Only its open P0 and P1 fixes go to fixes.md, the round's plan, and an implementer child
//      fixes them on the run branch in the run worktree, with the same flags as a ticket's child: fresh in the first
//      round, resuming that child's session after it. verify --full then judges the run head, and:
//        REVIEW <lens,…>  commits made and the evidence green: review-package --since writes review-fix.diff from the
//                         head the round started at, for the lenses named, those that had the round's findings
//        ROUND            a red introduced or incomplete, or a report with no status line, for another round
//        SUSPENDED        the child stopped at the usage limit: nothing is judged, and it costs no round
//        ATTENTION        for the human: no commits, BLOCKED or NEEDS_CONTEXT, a red inherited or environment, no evidence
//   run-stage.mjs ci-fix -> one CI fix round, once `run-state round ci` has counted it and ci-watch read CI as ours: the
//      round's plan, ci-plan.md, names the failing steps and has logs/ci-failure.log and ci.json as its context, and the
//      child fixes the run branch as review-fix's does, its report ci-fix.md. The verdicts are review-fix's, but for
//        PUSH             commits made and the evidence green: pr-open pushes them, and CI is read again
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readJson, git, gitError, runContext, runEnv, digest, ticketWorktree, ticketBranch, events, atUsageLimit, lock } from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url)), PLUGIN = path.dirname(HERE);
const [cmd, n] = process.argv.slice(2);
if (!["review-fix", "ci-fix"].includes(cmd) && (!["implement", "merge", "verify"].includes(cmd) || !/^\d{2}$/.test(n || ""))) { console.error("run-stage: usage: run-stage.mjs implement | merge | verify <NN> | review-fix | ci-fix --run <id>"); process.exit(2); }
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
// A docs, refactor or maintenance oneshot has no qa: the recipe's checks are its only proof, and the merge decision
// needs-human (#24).
// ponytail: merge-decision's triage.md parse, copied; share it from lib once the parallel edits have landed.
const triage = (() => { try { return JSON.parse([...fs.readFileSync(path.join(ctx.runDir, "triage.md"), "utf8").matchAll(/```json\s*\n([\s\S]*?)\n```/g)].at(-1)[1]); } catch { return {}; } })();
const noQa = (s) => s.route === "oneshot" && ["docs", "refactor", "maintenance"].includes(triage.type);

// The implementer's report: its last status line (null when it has none, an INCOMPLETE attempt), cause and concerns.
function report() {
  const text = fs.existsSync(IMPL) ? fs.readFileSync(IMPL, "utf8") : "", last = (re) => [...text.matchAll(re)].at(-1)?.[1];
  const concerns = (last(/^concerns:[ \t]*\n((?:[ \t]*- .*(?:\n|$))*)/gm) || "").split("\n").map((l) => l.trim()).filter((l) => l && l !== "- none");
  return { status: last(/^status:[ \t]*(DONE_WITH_CONCERNS|DONE|BLOCKED|NEEDS_CONTEXT)[ \t]*$/gm) || null, cause: last(/^blocked_cause:[ \t]*(\w+)/gm), concerns };
}
// What the ticket's files say comes next, as [word, why]. A plan is amended and a question researched once per ticket.
function verdict(s) {
  const { status, cause, concerns } = report(), first = s.dispatches.findIndex((d) => d.stage === stage);
  if (atUsageLimit(s.dispatches.findLast((d) => d.stage === stage)?.log)) return ["SUSPENDED", "the child stopped at the usage limit, which costs no round"];
  if (status === "BLOCKED" && cause === "bad_plan") return s.dispatches.some((d, i) => i > first && d.stage === `plan:${n}`)
    ? ["ATTENTION", "BLOCKED: bad_plan again, after the planner's one amendment"] : ["AMEND", "BLOCKED: bad_plan, so the ticket's commits are reset and the planner amends the plan"];
  if (status === "BLOCKED") return ["ATTENTION", cause === "intent_gap" ? "BLOCKED: intent_gap, the spec leaves open what to build" : `BLOCKED: ${cause || "no cause given"}, see implementation.md`];
  // a researcher dispatched before the latest attempt has had its one go; one dispatched since is answering this question
  const asked = s.dispatches.findIndex((d) => d.stage === `context:${n}`);
  if (status === "NEEDS_CONTEXT") return asked > -1 && asked < s.dispatches.findLastIndex((d) => d.stage === stage)
    ? ["ATTENTION", "NEEDS_CONTEXT again, after its one researcher dispatch"] : ["RESEARCH", `NEEDS_CONTEXT, so one researcher dispatch answers its question in ${path.join(dir, "context.md")}`];
  const ev = readJson(EVIDENCE), sha = head();
  if (!ev || ev.sha !== sha) return ["ATTENTION", `verify --full left no evidence at the ticket's HEAD ${sha?.slice(0, 7)}`];
  // qa:NN finished since the latest attempt: it walked the ticket and ruled on the pinned tests that attempt left red.
  // Without qa, a red pinned test is a fix round's.
  const walked = noQa(s) || s.dispatches.findLastIndex((d) => d.stage === `qa:${n}`) > s.dispatches.findLastIndex((d) => d.stage === stage) && s.stages_done.includes(`qa:${n}`);
  if (!ev.green && ev.pinned_only && ev.red_cause === "introduced" && !walked) return ["QA", `verify --full is red only in pinned tests at ${sha.slice(0, 7)}: `
    + `${ev.checks.filter((c) => c.status !== "pass").map((c) => c.check).join(", ")}, so qa rules on them`];
  if (!ev.green) return [["inherited", "environment"].includes(ev.red_cause) ? "ATTENTION" : "ROUND", `verify --full is red at ${sha.slice(0, 7)}, red_cause ${ev.red_cause}`];
  if (!status) return ["ROUND", "implementation.md has no status line, so the attempt is INCOMPLETE"];
  if (status === "DONE_WITH_CONCERNS" || concerns.length) return ["ROUND", "the implementer named a concern, which is fixed before the next ticket"];
  if (!walked && (readJson(path.join(wt, ".factory", "setup.json"), {}).apps || []).some((a) => a.dev)) {
    return ["QA", `DONE, and verify --full is green at ${sha.slice(0, 7)}, so qa walks ticket ${n}'s criteria`];
  }
  return ["MERGE", `DONE, and verify --full is green at ${sha.slice(0, 7)}`];
}

if (cmd === "merge") {
  lock(`${ctx.runDir}.merge.lock`);  // one ticket branch at a time, its verify --full included
  const s = state(), [word, why] = verdict(s);
  if (word !== "MERGE") die(`ticket ${n} isn't ready to merge: ${why}`);
  // Nothing merges into a red run head, so a red after a merge is always one between two green sides.
  const runEv = readJson(path.join(ctx.runDir, "evidence.json")), tip = git(ctx.worktree, "rev-parse", "HEAD");
  if (runEv?.sha === tip && !runEv.green) say("ATTENTION", `the run head is red at ${tip.slice(0, 7)}, so ${branch} isn't merged into it`);
  try { git(ctx.worktree, "merge", "-q", "--no-edit", branch); } catch (e) {
    const files = git(ctx.worktree, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
    try { git(ctx.worktree, "merge", "--abort"); } catch {}
    say("ATTENTION", `merging ${branch} into ${s.branch} conflicts${files.length ? ` in ${files.join(", ")}` : `: ${gitError(e)}`}, so the merge was aborted`);
  }
  const v = node("verify.mjs", ["--full", "--run", ctx.id], { cwd: ctx.MAIN }), sha = git(ctx.worktree, "rev-parse", "HEAD");
  console.log(v.stdout.split("\n")[0]);
  // The ticket's apps go down first, and its database with its worktree; a drop that fails keeps the worktree to retry
  // from. The branch is in the run branch now, which -d can't see from the main checkout. --force: the worktree's
  // ignored files, such as installed dependencies, go with it.
  const apps = node("run-apps.mjs", ["down", "--drop", "--run", ctx.id], { cwd: wt });
  if (apps.status) console.log(`ticket worktree kept: run-apps down failed\n${apps.stdout}${apps.stderr}`.trim());
  else try { git(ctx.MAIN, "worktree", "remove", "--force", wt); git(ctx.MAIN, "branch", "-q", "-D", branch); } catch (e) { console.log(`ticket worktree kept: ${gitError(e)}`); }
  const ev = readJson(path.join(ctx.runDir, "evidence.json"));
  if (!ev?.green || ev.sha !== sha) say("ATTENTION", `verify --full is red at the run head ${sha.slice(0, 7)} after merging two green sides, red_cause ${ev?.red_cause}`);
  if (told(runState("ticket", n, "done")).status) say("ATTENTION", `merged at ${sha.slice(0, 7)} and green, but ticket ${n} couldn't be marked done`);
  say("MERGED", `at ${sha.slice(0, 7)} on ${s.branch}, where verify --full is green`);
}

if (cmd === "verify") {
  if (!fs.existsSync(wt)) die(`ticket ${n} has no worktree to verify`);
  console.log(node("verify.mjs", ["--full", "--run", ctx.id], { cwd: wt }).stdout.split("\n")[0]);
  say(...verdict(state()));
}

if (["review-fix", "ci-fix"].includes(cmd)) {
  const review = cmd === "review-fix", CI = path.join(ctx.runDir, "ci.json"), CI_LOG = path.join(ctx.runDir, "logs", "ci-failure.log");
  const FIXES = path.join(ctx.runDir, review ? "fixes.md" : "ci-plan.md"), REPORT = path.join(ctx.runDir, `${cmd}.md`), RUN_EV = path.join(ctx.runDir, "evidence.json");
  const end = (word, why) => { console.log(`${word}: ${why}`); process.exit(0); };
  const synthesis = review && readJson(path.join(ctx.runDir, "findings.json")), ci = !review && readJson(CI);
  if (review && synthesis?.disposition !== "fix") die(`findings.json's disposition is ${synthesis?.disposition ?? "missing"}, and only fix starts a review fix round`);
  if (!review && ci?.cause !== "ours") die(`ci.json's cause is ${ci?.cause ?? "missing"}, and only ours starts a CI fix round`);
  // Only P0 and P1 fixes loop: a P2 goes to the PR, a P3 to deferred.md, and an ask to the human.
  const fixes = review ? synthesis.findings.filter((f) => f.status === "open" && ["P0", "P1"].includes(f.severity) && f.action === "fix") : [];
  const lenses = [...new Set(fixes.flatMap((f) => f.lens))];
  // the latest attempt whose session resumes: one cut off before a message or a result left none
  const s = state(), tries = s.dispatches.filter((d) => d.stage === cmd), last = tries.findLast((d) => d.session && events(d.log).some((e) => ["assistant", "result"].includes(e.type)));
  const statusOf = (file) => [...(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "").matchAll(/^status:[ \t]*(DONE_WITH_CONCERNS|DONE|BLOCKED|NEEDS_CONTEXT)[ \t]*$/gm)].at(-1)?.[1] || null;
  const was = readJson(RUN_EV), moved = fs.existsSync(REPORT) && path.join(ctx.runDir, `${cmd}.round${tries.length}.md`);
  const red = last && was && !was.green && was.sha === git(ctx.worktree, "rev-parse", "HEAD")
    && `verify --full is red at ${was.sha.slice(0, 7)}, red_cause ${was.red_cause}: ${RUN_EV} has each failing check's digest and log. Fix what it shows first. `;
  // fixes.md is the round's plan, with the files its findings sit in as its context (at most 8, as a plan's). It carries
  // each lens's claim and fix, never its evidence: a quote from the diff, which the implementer would take as the plan's.
  // ci-plan.md has the failing jobs' log and ci.json as its context, which are all a CI fix goes on.
  const files = [...new Set(fixes.map((f) => f.location.replaceAll("`", "").match(/^\s*([^\s:]+)/)?.[1]))].filter((f) => f && fs.existsSync(path.join(ctx.worktree, f)));
  const verification = `\n## Verification\n- \`node ${path.join(HERE, "verify.mjs")} --fast\` from the worktree → green\n`, nth = s.rounds?.[cmd]?.n ?? tries.length + 1;
  fs.writeFileSync(FIXES, review ? `---\nstatus: ready\nticket: review-fix\ncontext:\n${files.slice(0, 8).map((f) => `  - ${f}\n`).join("")}---\n\n`
    + `# Review fixes, round ${nth}\n\nThe run's review found these to fix. Fix each where its location says, with a test first where it's about behaviour, `
    + `and change nothing else. Each lens's file beside this one (review-<lens>.md) holds its findings in full.\n\n## Findings\n`
    + fixes.map((f) => `- **${f.id}** (${[f.severity, ...f.lens, f.cwe].filter(Boolean).join(", ")}) \`${f.location}\`: ${f.claim}${f.fix ? `\n  Fix: ${f.fix}` : ""}\n`).join("") + verification
    : `---\nstatus: ready\nticket: ci-fix\ncontext:\n  - ${CI_LOG}\n  - ${CI}\n---\n\n# CI fix, round ${nth}\n\n`
    + `CI on the run's PR is red at \`${ci.sha.slice(0, 7)}\`, failing at ${(ci.failing || []).map((f) => `\`${f}\``).join(", ")}: not the base's red, and not a flake its re-run cleared. `
    + `${CI_LOG} holds each failing job's whole log. Find the root cause in what the failing step printed, fix it in the product code with a test first `
    + "where it's about behaviour, and change nothing else. CI's workflows are locked: never make a step pass by changing what it runs.\n" + verification);
  const d = runState("dispatch", cmd);
  process.stdout.write(d.stdout);
  if (d.status) { process.stderr.write(d.stderr); process.exit(d.status); }
  const from = state().dispatches.at(-1).sha;
  // The same flags as a ticket's child (below), from the run worktree's recipe.
  // ponytail: the allowlist, the spawn and the denials copy the implement path's; share them once run-stage's parallel
  // edits have landed.
  const recipe = readJson(path.join(ctx.worktree, ".factory", "setup.json"), {});
  const program = (c) => String(c ?? "").trim().split(/\s+/).find((w) => !/^[A-Za-z_]\w*=/.test(w));
  const programs = (recipe.apps || []).flatMap((a) => Object.values(a.checks || {}).map((c) => program(typeof c === "string" ? c : c?.cmd))).filter(Boolean);
  const allowed = [...new Set([...programs.map((p) => `Bash(${p}:*)`), ...GIT.map((c) => `Bash(git ${c}:*)`),
    ...[...programs, program(recipe.setup)].filter((p) => INSTALL[p]).flatMap((p) => INSTALL[p].map((c) => `Bash(${p} ${c}:*)`)),
    `Bash(node ${path.join(HERE, "verify.mjs")}:*)`, "Skill(factory:ui-craft)"])];
  const again = moved ? ` Then write ${REPORT} again from the top: the last one is now ${moved}.` : "";
  const message = review ? (last ? `${red || ""}The review left open what ${FIXES} now lists: fix each finding there.${again}` : "The run's review found what the plan lists. Fix each finding, and nothing else.")
    : last ? `${red || ""}CI is still red, as ${FIXES} now says: fix it.${again}` : "CI on the run's PR is red where the plan says. Fix that, and nothing else.";
  const session = last ? last.session : crypto.randomUUID(), log = path.join(ctx.runDir, "logs", `${cmd}.${tries.length + 1}.jsonl`);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(log, "w");
  const child = spawn("claude", ["-p", "--agent", "factory:implementer", "--plugin-dir", PLUGIN, "--model", config.models?.implement || "sonnet", "--max-turns", String(MAX_TURNS),
    "--permission-mode", "acceptEdits", "--permission-prompts", "none", "--allowedTools", allowed.join(","), "--strict-mcp-config",
    "--add-dir", ctx.runDir, "--output-format", "stream-json", "--verbose", ...(last ? ["--resume", session] : ["--session-id", session])],
    { cwd: ctx.worktree, stdio: ["pipe", fd, fd] });
  fs.closeSync(fd);
  const exited = new Promise((resolve) => { child.on("error", resolve); child.on("close", () => resolve(null)); });
  if (!child.pid) end("ATTENTION", `claude couldn't start: ${(await exited)?.message}`);
  const lines = [`run_dir: ${ctx.runDir}`, `worktree: ${ctx.worktree}`, `ticket: ${cmd}`, `plan: ${FIXES}`, `implementation: ${REPORT}`];
  child.stdin.end(last ? `${message}\n` : `${lines.join("\n")}\n\n${message}\n`);
  told(runState("dispatch", cmd, "--log", log, "--pid", String(child.pid), "--session", session));
  await exited;

  const denials = fs.readFileSync(log, "utf8").split("\n").flatMap((l) => { try { const e = JSON.parse(l); return e.type === "result" ? e.permission_denials || [] : []; } catch { return []; } });
  if (denials.length) fs.appendFileSync(REPORT, `\nDenied, as the child's result records it:\n${denials.map((x) => `- \`${x.tool_name}: ${x.tool_input?.command ?? x.tool_input?.file_path ?? JSON.stringify(x.tool_input)}\``).join("\n")}\n`);
  if (atUsageLimit(log)) end("SUSPENDED", "the child stopped at the usage limit, which costs no round");
  const status = statusOf(REPORT);
  if (!["BLOCKED", "NEEDS_CONTEXT"].includes(status)) console.log(node("verify.mjs", ["--full", "--run", ctx.id], { cwd: ctx.MAIN }).stdout.split("\n")[0]);
  if (status) told(runState("done", cmd));
  const sha = git(ctx.worktree, "rev-parse", "HEAD"), made = Number(git(ctx.worktree, "rev-list", "--count", `${from}..HEAD`)), ev = readJson(RUN_EV);
  if (["BLOCKED", "NEEDS_CONTEXT"].includes(status)) end("ATTENTION", `${status}, see ${REPORT}`);
  if (!made) end("ATTENTION", `the fix round made no commits, so ${review ? "its findings stand" : "CI stays red"}`);
  if (!ev || ev.sha !== sha) end("ATTENTION", `verify --full left no evidence at the run head ${sha.slice(0, 7)}`);
  if (!ev.green) end(["inherited", "environment"].includes(ev.red_cause) ? "ATTENTION" : "ROUND", `verify --full is red at ${sha.slice(0, 7)}, red_cause ${ev.red_cause}`);
  if (!status) end("ROUND", `${REPORT} has no status line, so the round is INCOMPLETE`);
  if (!review) end("PUSH", `the fix round is green at ${sha.slice(0, 7)}, so pr-open.mjs pushes it and CI is read again`);
  const diff = node("review-package.mjs", ["--since", from, "--run", ctx.id], { cwd: ctx.MAIN });
  if (diff.status) end("ATTENTION", `the fix diff couldn't be written: ${diff.stderr.trim()}`);
  end(`REVIEW ${lenses.join(",")}`, `the fix round is green at ${sha.slice(0, 7)}, so the lenses that had its findings re-review review-fix.diff`);
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
// A session can be resumed once one of its logs holds an assistant message or a result: a child cut off before either
// left no conversation to resume, and a fresh child is pointed at what that attempt left instead.
const spoke = (d) => events(d.log).some((e) => ["assistant", "result"].includes(e.type));
const resumable = (session) => before.dispatches.some((d) => d.session === session && spoke(d));
const sincePlan = before.dispatches.slice(planned + 1).filter((d) => d.stage === stage), lastTry = sincePlan.at(-1);
const last = sincePlan.filter((d) => d.session && resumable(d.session)).at(-1);  // the latest attempt whose session resumes
const escalated = !!last && atLast && (last.round || 0) < round, fresh = !last || escalated;
const [was] = attempts ? verdict(before) : [], { status: wasStatus } = report();
const ev = readJson(EVIDENCE), moved = fs.existsSync(IMPL) && path.join(dir, `implementation.round${attempts}.md`);

const d = runState("dispatch", stage);
process.stdout.write(d.stdout);
if (d.status) { process.stderr.write(d.stderr); process.exit(d.status); }
const cut = state().dispatches.find((x) => x.stage === stage).sha;
if (!fs.existsSync(wt)) {
  // The branch first, never `worktree add -b`, which can fail with its branch made (lib's git), and a branch whose
  // worktree couldn't be made goes again, so the next attempt makes both.
  const unmade = (e) => say("ATTENTION", `the ticket's worktree couldn't be made: ${gitError(e)}`);
  try { git(ctx.MAIN, "branch", branch, cut); } catch (e) { unmade(e); }
  try { git(ctx.MAIN, "worktree", "add", "-q", wt, branch); } catch (e) { try { git(ctx.MAIN, "branch", "-q", "-D", branch); } catch {} unmade(e); }
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
  `Bash(node ${path.join(HERE, "verify.mjs")}:*)`, "Skill(factory:ui-craft)"])];  // Skill asks first, and a plan with UI states loads this one

// What the child is told: the plan for a fresh child, else what its last attempt left to do.
function message() {
  const again = moved ? ` Then write ${IMPL} again from the top: the last one is now ${moved}.` : "";
  const tries = round - 1 === 2 ? "twice" : `${round - 1} times`;
  const red = ev && !ev.green && ev.sha === head(), failingPins = red ? ev.checks.filter((c) => c.pinned && c.status === "fail").map((c) => c.check) : [];
  const pinNote = failingPins.length ? ` Failing pinned tests: ${failingPins.join(", ")}. Make each pass by changing the product code; one the spec `
    + `contradicts goes under concerns:, untouched, for qa to rule on. \`node ${path.join(HERE, "verify.mjs")} --pinned <path>\` runs one with the apps up.` : "";
  if (escalated) return `A prior implementer has worked on this ticket and tried ${tries} to fix it; you own it now. Its commits stay on this branch. `
    + `Read the plan, then its last report${moved ? ` (${moved})` : ""} and the last evidence (${EVIDENCE}), and carry on from the code as it is.${pinNote}`;
  if (fresh && lastTry) return `A previous attempt at this ticket was cut off before it left a session to resume. \`git log --oneline ${lastTry.sha}..HEAD\` lists what it committed`
    + `${moved ? `, and ${moved} what it reported` : ""}. Read the plan, then carry on from the code as it is.`;
  if (fresh) return "Implement the plan.";
  if (was === "ROUND" && red) return `verify --full is red at ${ev.sha.slice(0, 7)}, red_cause ${ev.red_cause}: ${EVIDENCE} has each failing check's digest and log. Fix what it shows.${pinNote}${again}`;
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
if (atUsageLimit(log)) say(...verdict(state()));  // SUSPENDED, unverified and not done
const { status } = report();
if (!["BLOCKED", "NEEDS_CONTEXT"].includes(status)) console.log(node("verify.mjs", ["--full", "--run", ctx.id], { cwd: wt }).stdout.split("\n")[0]);
if (status) told(runState("done", stage));
const [word, why] = verdict(state());
if (word === "AMEND") { git(wt, "reset", "-q", "--hard", cut); git(wt, "clean", "-qfd"); }
say(word, why);
