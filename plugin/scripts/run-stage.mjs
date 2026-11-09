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
//   run-stage.mjs merge <NN> -> after MERGE: on a GitHub origin, pushes the run branch and factory/<run>/NN and opens the
//      ticket's PR into the run branch, stacked on the run's own PR (#81), recorded in tickets/NN/pr.json; a push or call
//      that fails is printed and the merge goes on. It merges factory/<run>/NN into the run branch. When the merge added or changed
//      an app manifest (lib's MANIFEST) or a lockfile, it runs the recipe's setup in the run worktree, else the package
//      manager's install (logs/install-NN.log); for a manifest, `setup-factory.mjs redetect` then re-detects and commits
//      the recipe there. It runs verify --full at the new head, then takes the ticket's apps and database down (run-apps
//      down --drop there) and removes its worktree and branch. MERGED (the ticket marked done) when the run head is
//      green, once the run branch is pushed, which GitHub reads as the ticket PR's merge; ATTENTION when it's red, when the install or re-detecting fails, or on a conflict, which is aborted and
//      leaves everything as it was. Merges of one run wait on each other, and none goes into a run head whose evidence
//      is red.
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
import { readJson, git, gitError, runContext, runEnv, digest, ticketWorktree, ticketBranch, events, atUsageLimit, lock, attributed, githubRepo, ghApi, pushBranch, installOf, MANIFEST, LOCKFILE, SETTINGS, factoryRules } from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url)), PLUGIN = path.dirname(HERE);
const [cmd, n] = process.argv.slice(2);
if (!["review-fix", "ci-fix"].includes(cmd) && (!["implement", "merge", "verify"].includes(cmd) || !/^\d{2}$/.test(n || ""))) { console.error("run-stage: usage: run-stage.mjs implement | merge | verify <NN> | review-fix | ci-fix --run <id>"); process.exit(2); }
const ctx = runContext(), stage = `implement:${n}`;
const wt = ticketWorktree(ctx.MAIN, ctx.id, n), branch = ticketBranch(ctx.id, n), dir = path.join(ctx.runDir, "tickets", n);
const IMPL = path.join(dir, "implementation.md"), EVIDENCE = path.join(dir, "evidence.json");
// the child's --max-turns: the implementer's own maxTurns
const MAX_TURNS = fs.readFileSync(path.join(PLUGIN, "agents", "implementer.md"), "utf8").match(/^maxTurns:[ \t]*(\d+)/m)[1];
// What the implementer child may run: the factory's rules for the run worktree's recipe (lib's factoryRules), verify, and
// each rule the project's .claude/settings.json allows, where setup and `run-state allow` put them (a recipe from before
// that holds them in its own allow list). Both are read from the run worktree, so a change on the run branch reaches a
// ticket cut before it. Reads and edits in its worktree and the run dir need no rule under acceptEdits.
function allowlist() {
  const recipe = readJson(path.join(ctx.worktree, ".factory", "setup.json"), {});
  const allowed = readJson(path.join(ctx.worktree, SETTINGS), {}).permissions?.allow || [];
  const rules = factoryRules(ctx.worktree, recipe);
  // The whole package manager and curl, the child's alone (#81): it runs node already, so its subcommands, flags first
  // (`pnpm --filter api add zod`, `pnpm -r ls`), and a request to its own dev server add no reach, and each denial cost
  // the human a stop. Never the project's settings, where every session would get them.
  const whole = managers(rules).map((pm) => `Bash(${pm}:*)`);
  // the Skill rule asks first, and a plan with UI states loads that skill
  return [...new Set([...rules, ...whole, "Bash(curl:*)", `Bash(node ${path.join(HERE, "verify.mjs")}:*)`, "Skill(factory:ui-craft)",
    ...allowed.filter((r) => r.startsWith("Bash(")), ...(recipe.allow || [])])];
}
// The package managers the child's rules name, and what it is denied of them however it's allowed: publishing, which a
// deny rule stops ahead of any allow (#81).
const managers = (rules) => [...new Set(rules.map((r) => r.match(/^Bash\((npm|pnpm|yarn|bun) /)?.[1]).filter(Boolean))];
// ponytail: rules match by prefix, so a flag that comes first in some other order (`npm -w pkg publish`) slips past; node
// reaches a publish anyway, so these keep the plain forms out by mistake, not a determined child.
const denylist = () => managers(allowlist()).flatMap((pm) => ["publish", "unpublish", "-r publish", "--recursive publish", "--workspaces publish", "-ws publish", "npm publish"]
  .map((c) => `Bash(${pm} ${c}:*)`)).concat(managers(allowlist()).includes("npm") ? ["dist-tag", "deprecate", "owner", "token", "access"].map((c) => `Bash(npm ${c}:*)`) : []);
const config = readJson(path.join(ctx.MAIN, ".factory", "config.json"), {});
// From the main checkout, never this process's cwd, which a merge may have just removed (a ticket's worktree, #81).
const node = (script, args, opts) => spawnSync(process.execPath, [path.join(HERE, script), ...args], { encoding: "utf8", cwd: ctx.MAIN, ...opts });
const runState = (...args) => node("run-state.mjs", [...args, "--run", ctx.id]);
const told = (r) => { if (r.status) console.log(`${r.stdout}${r.stderr}`.trim()); return r; };  // a run-state refusal, printed
const state = () => readJson(ctx.state);
const say = (word, why) => { console.log(`${word} ${n}: ${why}`); process.exit(0); };
const die = (msg) => { console.error(`run-stage: ${msg}`); process.exit(2); };
const head = () => fs.existsSync(wt) ? git(wt, "rev-parse", "HEAD") : null;
// What a child left running in its worktree once it exits (#81), such as a server it started and never stopped, which
// would hold the ticket's ports through verify: every process whose working directory is inside `dir`, but this one and
// its ancestors, gets SIGTERM. Nothing outside the factory's own worktree is touched. Prints what it stopped.
function sweep(dir) {
  const real = fs.realpathSync(dir), inside = (p) => p === real || p.startsWith(real + path.sep), mine = new Set();
  for (let p = process.pid; p > 1 && !mine.has(p);) { mine.add(p); p = Number(spawnSync("ps", ["-o", "ppid=", "-p", String(p)], { encoding: "utf8" }).stdout?.trim()) || 0; }
  const found = [];
  if (fs.existsSync("/proc/self/cwd")) {
    for (const d of fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d))) { try { if (inside(fs.readlinkSync(`/proc/${d}/cwd`))) found.push(Number(d)); } catch {} }
  } else {
    let pid;
    for (const l of (spawnSync("lsof", ["-d", "cwd", "-F", "pn"], { encoding: "utf8", maxBuffer: 1 << 26 }).stdout || "").split("\n")) {
      if (l[0] === "p") pid = Number(l.slice(1)); else if (l[0] === "n" && inside(l.slice(1))) found.push(pid);
    }
  }
  const left = [...new Set(found)].filter((p) => p && !mine.has(p));
  for (const p of left) { try { process.kill(p, "SIGTERM"); } catch {} }
  if (left.length) console.log(`stopped what the child left running in its worktree: pid ${left.join(", ")}`);
}
// The recipe's setup, or an install, under bash in cwd with lib's runEnv and its output saved to log. One that fails
// prints the digest of its output and returns false.
function runSetup(cwd, command, log) {
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(log, "w"), r = spawnSync("bash", ["-c", command], { cwd, env: runEnv(ctx.MAIN), stdio: ["ignore", fd, fd], timeout: 10 * 60_000 });
  fs.closeSync(fd);
  if (r.status !== 0) console.log(digest(fs.readFileSync(log, "utf8"), log));
  return r.status === 0;
}
// A docs, refactor or maintenance oneshot has no qa: the recipe's checks are its only proof, and the merge decision
// needs-human (#24).
// ponytail: merge-decision's triage.md parse, copied; share it from lib once the parallel edits have landed.
const triage = (() => { try { return JSON.parse([...fs.readFileSync(path.join(ctx.runDir, "triage.md"), "utf8").matchAll(/```json\s*\n([\s\S]*?)\n```/g)].at(-1)[1]); } catch { return {}; } })();
const noQa = (s) => s.route === "oneshot" && ["docs", "refactor", "maintenance"].includes(triage.type);

// The implementer's report: its last status line (null when it has none, an INCOMPLETE attempt), cause and concerns, and
// each command denied it, from its own denied: list and the one copied from its result.
function report() {
  const text = fs.existsSync(IMPL) ? fs.readFileSync(IMPL, "utf8") : "", last = (re) => [...text.matchAll(re)].at(-1)?.[1];
  const concerns = (last(/^concerns:[ \t]*\n((?:[ \t]*- .*(?:\n|$))*)/gm) || "").split("\n").map((l) => l.trim()).filter((l) => l && l !== "- none");
  const denied = [...text.matchAll(/^(?:denied:|Denied, as the child's result records it:)[ \t]*\n((?:[ \t]*- .*(?:\n|$))*)/gm)]
    .flatMap((m) => [...m[1].matchAll(/^[ \t]*- `(?:Bash: )?([^`]+)`/gm)].map((x) => x[1]));
  return { status: last(/^status:[ \t]*(DONE_WITH_CONCERNS|DONE|BLOCKED|NEEDS_CONTEXT)[ \t]*$/gm) || null, cause: last(/^blocked_cause:[ \t]*(\w+)/gm), concerns, denied: [...new Set(denied)] };
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
  // A concern a round left as it was, with no commit, isn't one code fixes (a check the child may not run, say): it goes
  // to the PR in implementation.md, and the ticket goes on, its own evidence green (#81).
  const tries = s.dispatches.filter((d) => d.stage === stage), built = tries.length && git(wt, "rev-list", "--count", `${tries[0].sha}..HEAD`) !== "0";
  const again = tries.length > 1 && tries.at(-1).sha === sha && built;
  if ((status === "DONE_WITH_CONCERNS" || concerns.length) && !again) return ["ROUND", "the implementer named a concern, which is fixed before the next ticket"];
  if (!walked && (readJson(path.join(wt, ".factory", "setup.json"), {}).apps || []).some((a) => a.dev)) {
    return ["QA", `DONE, and verify --full is green at ${sha.slice(0, 7)}, so qa walks ticket ${n}'s criteria`];
  }
  return ["MERGE", again ? `its concern, which a round left as it was, goes to the PR, and verify --full is green at ${sha.slice(0, 7)}` : `DONE, and verify --full is green at ${sha.slice(0, 7)}`];
}

// The ticket's PR into the run branch (#81): the run branch and the ticket's pushed, then the PR opened, or found when
// an earlier merge attempt opened it. Best effort: no GitHub origin, or a push or call that fails, prints why and leaves
// the merge as it was, local alone.
function ticketPr(s) {
  const repo = githubRepo(ctx.MAIN), file = path.join(dir, "pr.json");
  if (!repo || readJson(file)) return readJson(file);
  // A CI change goes to GitHub only in the run's PR, after the security lens has read it: pushed earlier, a workflow
  // would run there with the repo's secrets before any review. So a ticket or run branch carrying one opens no ticket PR.
  const ci = [s.branch, branch].flatMap((b) => git(ctx.MAIN, "diff", "--name-only", s.base_sha, b).split("\n")).filter((f) => /^\.github\/(workflows|actions)\//.test(f));
  if (ci.length) return console.log(`ticket PR skipped: the branch changes CI (${[...new Set(ci)].join(", ")}), which reaches GitHub only in the run's reviewed PR`), null;
  for (const b of [s.branch, branch]) { const why = pushBranch(ctx.MAIN, b); if (why) return console.log(`ticket PR skipped: ${b} couldn't be pushed: ${why}`), null; }
  const name = fs.readdirSync(path.join(ctx.runDir, "tickets")).find((f) => f.startsWith(`${n}-`) && f.endsWith(".md")) ?? `${n}.md`;
  const title = fs.readFileSync(path.join(ctx.runDir, "tickets", name), "utf8").match(/^# (.+)$/m)?.[1].trim() || name.slice(0, -3);
  const commits = (fs.existsSync(IMPL) ? fs.readFileSync(IMPL, "utf8") : "").split("\n").filter((l) => /^- [0-9a-f]{7,} /.test(l));
  const body = `Ticket ${n} of run \`${ctx.id}\`, stacked on \`${s.branch}\`, whose own PR goes to \`${s.target_branch || s.base_branch}\`. `
    + "The factory merges it once verify is green at the merged head; review the run's PR.\n\n"
    + (commits.length ? `## Commits\n${commits.join("\n")}\n` : "") + (s.ticket_issues?.[n]?.key ? `\nTicket: ${s.ticket_issues[n].key}\n` : "");
  let r = ghApi("-X", "POST", `repos/${repo}/pulls`, "-f", `title=${title}`, "-f", `head=${branch}`, "-f", `base=${s.branch}`, "-f", `body=${attributed(body, "pr", s)}`);
  if (!r.ok) {
    const found = ghApi(`repos/${repo}/pulls?head=${repo.split("/")[0]}:${encodeURIComponent(branch)}&state=open`);
    if (!found.ok || !found.json?.[0]) return console.log(`ticket PR skipped: GitHub refused it: ${r.message}`), null;
    r = { json: found.json[0] };
  }
  const pr = { repo, number: r.json.number, url: r.json.html_url, head: branch, base: s.branch };
  fs.writeFileSync(file, JSON.stringify(pr, null, 2) + "\n");
  console.log(`ticket PR #${pr.number} into ${s.branch}: ${pr.url}`);
  return pr;
}

if (cmd === "merge") {
  lock(`${ctx.runDir}.merge.lock`);  // one ticket branch at a time, its verify --full included
  const s = state(), [word, why] = verdict(s);
  if (word !== "MERGE") die(`ticket ${n} isn't ready to merge: ${why}`);
  const pr = ticketPr(s);
  // Nothing merges into a red run head, so a red after a merge is always one between two green sides.
  const runEv = readJson(path.join(ctx.runDir, "evidence.json")), tip = git(ctx.worktree, "rev-parse", "HEAD");
  if (runEv?.sha === tip && !runEv.green) say("ATTENTION", `the run head is red at ${tip.slice(0, 7)}, so ${branch} isn't merged into it`);
  try { git(ctx.worktree, "merge", "-q", "--no-edit", "-m", attributed(`Merge branch '${branch}' into ${s.branch}`, "commit", s), branch); } catch (e) {
    const files = git(ctx.worktree, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
    try { git(ctx.worktree, "merge", "--abort"); } catch {}
    say("ATTENTION", `merging ${branch} into ${s.branch} conflicts${files.length ? ` in ${files.join(", ")}` : `: ${gitError(e)}`}, so the merge was aborted`);
  }
  // The run worktree installs before verify, by the recipe's setup, else its package manager's install: it has no
  // dependencies of its own, and the main checkout's it finds by walking up lack the ticket's (in an empty repo, none).
  const touched = git(ctx.worktree, "diff", "--name-only", tip, "HEAD").split("\n"), recipe = readJson(path.join(ctx.worktree, ".factory", "setup.json"), {});
  // Every merge installs: the run worktree has none of its own until it does (#81), and one that is up to date is quick.
  const install = installOf(recipe);
  if (install && !runSetup(ctx.worktree, install, path.join(ctx.runDir, "logs", `install-${n}.log`))) {
    say("ATTENTION", `merged ${branch}, but \`${install}\` failed in the run worktree, as printed above, so verify didn't run`);
  }
  // A ticket that adds or changes an app's manifest re-detects the recipe on the run branch, so verify judges the head
  // with it, and later tickets, run-apps and qa read it there.
  const redetected = touched.some((f) => MANIFEST.test(f)) && node("setup-factory.mjs", ["redetect", "--worktree", ctx.worktree]);
  if (redetected) console.log(`${redetected.stdout}${redetected.status ? redetected.stderr : ""}`.trim());
  if (redetected?.status) say("ATTENTION", `merged ${branch}, but re-detecting the recipe failed, as printed above: `
    + `run ${path.join(HERE, "setup-factory.mjs")} redetect --worktree ${ctx.worktree} once it's fixed`);
  // The ticket's green evidence: a merge that left its tree as it was runs none of its pinned tests again (#81).
  const v = node("verify.mjs", ["--full", "--reuse", path.join(dir, "evidence.json"), "--run", ctx.id], { cwd: ctx.MAIN }), sha = git(ctx.worktree, "rev-parse", "HEAD");
  console.log(v.stdout.split("\n")[0]);
  // The ticket's apps go down first, and its database with its worktree; a drop that fails keeps the worktree to retry
  // from. The branch is in the run branch now, which -d can't see from the main checkout. --force: the worktree's
  // ignored files, such as installed dependencies, go with it.
  const apps = node("run-apps.mjs", ["down", "--drop", "--run", ctx.id], { cwd: wt });
  if (apps.status) console.log(`ticket worktree kept: run-apps down failed\n${apps.stdout}${apps.stderr}`.trim());
  else try { git(ctx.MAIN, "worktree", "remove", "--force", wt); git(ctx.MAIN, "branch", "-q", "-D", branch); } catch (e) { console.log(`ticket worktree kept: ${gitError(e)}`); }
  const ev = readJson(path.join(ctx.runDir, "evidence.json"));
  if (!ev?.green || ev.sha !== sha) say("ATTENTION", `verify --full is red at the run head ${sha.slice(0, 7)} after merging two green sides${redetected ? " and re-detecting the recipe" : ""}, red_cause ${ev?.red_cause}`);
  if (told(runState("ticket", n, "done")).status) say("ATTENTION", `merged at ${sha.slice(0, 7)} and green, but ticket ${n} couldn't be marked done`);
  // The push GitHub reads as the ticket PR's merge, since its head is now in the run branch; its branch then goes.
  if (pr) {
    const why = pushBranch(ctx.MAIN, s.branch);
    if (why) console.log(`ticket PR #${pr.number} left open: ${s.branch} couldn't be pushed: ${why}`);
    else { spawnSync("git", ["push", "-q", "origin", "--delete", branch], { cwd: ctx.MAIN, timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }); console.log(`ticket PR #${pr.number} merged by the push of ${s.branch}`); }
  }
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
  // Only P0 and P1 fixes loop, a lens's ask among them as a judgment call (#81): a P2 goes to the PR, a P3 to deferred.md,
  // and a human's question on the PR to them.
  const call = (f) => f.action === "ask", humans = (f) => f.lens.includes("human") && call(f);
  const fixes = review ? synthesis.findings.filter((f) => f.status === "open" && !humans(f) && (f.severity === "P0" || (f.severity === "P1" && f.action !== "note"))) : [];
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
    + `and change nothing else. Each lens's file beside this one (review-<lens>.md) holds its findings in full. A finding marked `
    + "judgment call is yours to decide: take the option that keeps closest to spec.md and the repo's own ways, make it, and say "
    + `which you took and why under \`assumptions:\` in ${REPORT}, as \`- <id>: <the call>\`, which the PR lists.\n\n## Findings\n`
    + fixes.map((f) => `- **${f.id}** (${[f.severity, ...f.lens, f.cwe, call(f) && "judgment call"].filter(Boolean).join(", ")}) \`${f.location}\`: ${f.claim}${f.fix ? `\n  Fix: ${f.fix}` : ""}\n`).join("") + verification
    : `---\nstatus: ready\nticket: ci-fix\ncontext:\n  - ${CI_LOG}\n  - ${CI}\n---\n\n# CI fix, round ${nth}\n\n`
    + `CI on the run's PR is red at \`${ci.sha.slice(0, 7)}\`, failing at ${(ci.failing || []).map((f) => `\`${f}\``).join(", ")}: not the base's red, and not a flake its re-run cleared. `
    + `${CI_LOG} holds each failing job's whole log. Find the root cause in what the failing step printed, fix it in the product code with a test first `
    + "where it's about behaviour, and change nothing else. CI's workflows are locked: never make a step pass by changing what it runs.\n" + verification);
  const d = runState("dispatch", cmd);
  process.stdout.write(d.stdout);
  if (d.status) { process.stderr.write(d.stderr); process.exit(d.status); }
  const from = state().dispatches.at(-1).sha;
  // The same flags as a ticket's child (below).
  // ponytail: the spawn and the denials copy the implement path's; share them once run-stage's parallel edits have landed.
  const again = moved ? ` Then write ${REPORT} again from the top: the last one is now ${moved}.` : "";
  const message = review ? (last ? `${red || ""}The review left open what ${FIXES} now lists: fix each finding there.${again}` : "The run's review found what the plan lists. Fix each finding, and nothing else.")
    : last ? `${red || ""}CI is still red, as ${FIXES} now says: fix it.${again}` : "CI on the run's PR is red where the plan says. Fix that, and nothing else.";
  const session = last ? last.session : crypto.randomUUID(), log = path.join(ctx.runDir, "logs", `${cmd}.${tries.length + 1}.jsonl`);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(log, "w");
  const child = spawn("claude", ["-p", "--agent", "factory:implementer", "--plugin-dir", PLUGIN, "--model", config.models?.implement || "sonnet", "--max-turns", String(MAX_TURNS),
    "--permission-mode", "acceptEdits", "--permission-prompts", "none", "--allowedTools", allowlist().join(","), ...(denylist().length ? ["--disallowedTools", denylist().join(",")] : []), "--strict-mcp-config",
    "--add-dir", ctx.runDir, "--output-format", "stream-json", "--verbose", ...(last ? ["--resume", session] : ["--session-id", session])],
    { cwd: ctx.worktree, stdio: ["pipe", fd, fd], env: { ...process.env, FACTORY_CHILD: "1" } });
  fs.closeSync(fd);
  const exited = new Promise((resolve) => { child.on("error", resolve); child.on("close", () => resolve(null)); });
  if (!child.pid) end("ATTENTION", `claude couldn't start: ${(await exited)?.message}`);
  const lines = [`run_dir: ${ctx.runDir}`, `worktree: ${ctx.worktree}`, `ticket: ${cmd}`, `plan: ${FIXES}`, `implementation: ${REPORT}`];
  child.stdin.end(last ? `${message}\n` : `${lines.join("\n")}\n\n${message}\n`);
  told(runState("dispatch", cmd, "--log", log, "--pid", String(child.pid), "--session", session));
  await exited;
  sweep(ctx.worktree);

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
const [was] = attempts ? verdict(before) : [], { status: wasStatus, cause: wasCause, denied: wasDenied } = report();
// Claude Code tells a child not to retry what it denied for the rest of its session, so a resumed child is told which of
// those commands the human has since allowed. A chained one isn't, since a rule covers only its first part.
const covers = (rule, c) => { const [, cmd, any] = rule.match(/^Bash\((.+?)(:\*)?\)$/) || []; return !!cmd && (c === cmd || (!!any && c.startsWith(`${cmd} `))); };
const allowedNow = wasDenied.filter((c) => !/[;&|<>`$()]/.test(c) && allowlist().some((r) => covers(r, c)));
const retry = allowedNow.length ? `The human has since allowed ${allowedNow.map((c) => `\`${c}\``).join(", ")}, which you were denied: `
  + "that denial no longer holds, so run each again. " : "";
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
  // Every app's dependencies, so verify judges the ticket and not a missing install (#81).
  const setup = installOf(readJson(path.join(wt, ".factory", "setup.json"), {}));
  if (setup && !runSetup(wt, setup, path.join(ctx.runDir, "logs", `setup-${n}.log`))) {
    // Nothing is committed yet, so the next attempt cuts the worktree again and reruns the setup.
    git(ctx.MAIN, "worktree", "remove", "--force", wt); git(ctx.MAIN, "branch", "-q", "-D", branch);
    say("ATTENTION", `\`${setup}\` failed in the ticket's worktree`);
  }
}

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
  if (wasStatus === "BLOCKED" && wasCause === "environment") return retry ? `Then carry on with the plan.${again}` : `The human allowed commands you were denied: try each again, then carry on with the plan.${again}`;
  return `Carry on with the plan where you left off.${again}`;
}
const lines = [`run_dir: ${ctx.runDir}`, `worktree: ${wt}`, `ticket: ${ticket}`, `plan: ${path.join(dir, "plan.md")}`, `implementation: ${IMPL}`];
const session = fresh ? crypto.randomUUID() : last.session;
const model = atLast ? config.models?.implement_escalated || "opus" : config.models?.implement || "sonnet";
const log = path.join(ctx.runDir, "logs", `implement-${n}.${attempts + 1}.jsonl`);
fs.mkdirSync(path.dirname(log), { recursive: true });
const fd = fs.openSync(log, "w");
const child = spawn("claude", ["-p", "--agent", "factory:implementer", "--plugin-dir", PLUGIN, "--model", model, "--max-turns", String(MAX_TURNS),
  "--permission-mode", "acceptEdits", "--permission-prompts", "none", "--allowedTools", allowlist().join(","), ...(denylist().length ? ["--disallowedTools", denylist().join(",")] : []), "--strict-mcp-config",
  "--add-dir", ctx.runDir, "--output-format", "stream-json", "--verbose", ...(fresh ? ["--session-id", session] : ["--resume", session])],
  { cwd: wt, stdio: ["pipe", fd, fd], env: { ...process.env, FACTORY_CHILD: "1" } });
fs.closeSync(fd);
const exited = new Promise((resolve) => { child.on("error", resolve); child.on("close", () => resolve(null)); });
if (!child.pid) say("ATTENTION", `claude couldn't start: ${(await exited)?.message}`);
child.stdin.end(fresh ? `${lines.join("\n")}\n\n${message()}\n` : `${retry}${message()}\n`);
told(runState("dispatch", stage, "--log", log, "--pid", String(child.pid), "--session", session));
await exited;
sweep(wt);

// The child is judged by what it left, never by its exit code: a child out of turns exits 1 (docs/platform-facts.md).
// What Claude Code denied it is copied into its report from its result, so a stop names what to allow even when the
// child ran out of turns before writing its own denied: list.
const denials = fs.readFileSync(log, "utf8").split("\n").flatMap((l) => { try { const e = JSON.parse(l); return e.type === "result" ? e.permission_denials || [] : []; } catch { return []; } });
if (denials.length) fs.appendFileSync(IMPL, `\nDenied, as the child's result records it:\n${denials.map((x) => `- \`${x.tool_name}: ${x.tool_input?.command ?? x.tool_input?.file_path ?? JSON.stringify(x.tool_input)}\``).join("\n")}\n`);
if (atUsageLimit(log)) say(...verdict(state()));  // SUSPENDED, unverified and not done
const { status } = report();
// A ticket that adds or changes an app's manifest re-detects the recipe in its own worktree first (#81), so verify judges
// it with the app it added, and what that app lacks (a test script, say) is this ticket's to fix in a round, before it
// merges. A re-detect that fails is printed, and the merge's own re-detect stops on it.
if (!["BLOCKED", "NEEDS_CONTEXT"].includes(status) && git(wt, "diff", "--name-only", cut, "HEAD").split("\n").some((f) => MANIFEST.test(f))) {
  const r = node("setup-factory.mjs", ["redetect", "--worktree", wt, "--run-dir", ctx.runDir]);
  console.log(`${r.stdout}${r.status ? r.stderr : ""}`.trim());
}
if (!["BLOCKED", "NEEDS_CONTEXT"].includes(status)) console.log(node("verify.mjs", ["--full", "--run", ctx.id], { cwd: wt }).stdout.split("\n")[0]);
if (status) told(runState("done", stage));
const [word, why] = verdict(state());
if (word === "AMEND") { git(wt, "reset", "-q", "--hard", cut); git(wt, "clean", "-qfd"); }
say(word, why);
