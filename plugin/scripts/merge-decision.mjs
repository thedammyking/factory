#!/usr/bin/env node
// merge-decision.mjs [--record] — writes the run's decision.json: merge only when every fact below holds at the run head,
// else needs-human with each fact that doesn't, as `<fact>: <what it read>`, the files that show it beside it. Facts, never
// an agent's judgement. Takes --run <id>, or derives the run from the run worktree it runs in. --record is the trial
// record instead (below).
//   - The diff is the run's from its merge base with lib's live base (design fix 21), the factory's bookkeeping left out
//     (design fix 2): the base's own commits are never the run's.
//   - A run file a fact reads that's missing, or was written at another head, never lets it hold: unknown is no pass.
//   - The mode is config.merge, trial unless it says auto, and auto acts as trial while a factory revert PR is open. In
//     auto a merge decision merges the PR, and a run behind its base and nothing else is asked for one catch-up.
//   - A oneshot's one criterion is triage's acceptance check, and oneshot_scope holds it to one product file.
// Prints `DECISION <merge|needs-human> (<mode>) at <sha>`, then each failing fact, then `MERGED <sha>: PR #<n>` once it
// merged; or only `CATCH-UP …`, writing no decision, when it asks for the catch-up.
import fs from "node:fs";
import path from "node:path";
import { readJson, git, gitError, runContext, mainRoot, liveBase, ghApi, PRODUCT, LOCKED, PLATFORM_NAMES, unverifiedNative } from "./lib.mjs";

const short = (sha) => String(sha ?? "none").slice(0, 7);

// --record: the trial record, for the retro, from each ended run's decision.json under .factory/history/, as its snapshot
// committed it on whichever base holds it (runContext reads an ended run's record so too), and its PR as GitHub has it
// now, over REST. A trial merge decision agrees when its PR merged at the head decided and CI is green at its merge
// commit; it disagrees when the human added commits, closed it unmerged, or CI went red there. An open PR, CI unfinished
// or absent there, and needs-human or auto decisions don't count. It writes nothing: only the human switches the mode
// (#15). Prints a line per trial merge decision, oldest first, then `RECORD <n> of the last <k> counted agree (…)`, k
// being 10 at most.
// ponytail: every ended run is read from GitHub on every call, one page of 100 workflow runs at its merge commit; keep
// the verdicts already final if a project's history ever makes that slow.
if (process.argv.includes("--record")) {
  const MAIN = mainRoot(), OK = ["success", "neutral", "skipped"];
  const committed = (f) => { try { return JSON.parse(git(MAIN, "show", `${git(MAIN, "log", "--all", "-1", "--format=%H", "--", f)}:${f}`)); } catch { return null; } };
  const ids = new Set(git(MAIN, "log", "--all", "--format=", "--name-only", "--", ".factory/history/*/decision.json").split("\n").filter(Boolean).map((f) => f.split("/")[2]));
  const ended = [...ids].map((id) => ({ id, d: committed(`.factory/history/${id}/decision.json`), pr: committed(`.factory/history/${id}/pr.json`) }))
    .filter(({ d, pr }) => d?.mode === "trial" && d.decision === "merge" && pr).sort((a, b) => String(a.d.decided_at).localeCompare(String(b.d.decided_at)));
  // [agrees, why] for one decision, agrees null when it doesn't count yet
  const judge = (d, pr) => {
    const r = ghApi(`repos/${pr.repo}/pulls/${pr.number}`), live = r.json;
    if (!r.ok) return [null, `unread: ${r.message}`];
    if (live.state === "open") return [null, "open"];
    if (!live.merged) return [false, "closed unmerged"];
    if (live.head?.sha !== d.head) return [false, `merged at ${short(live.head?.sha)}, not ${short(d.head)} as decided: the human added commits`];
    // ponytail: a project whose workflows run only on pull_request has no CI at a merge commit, so its decisions never
    // count; read the PR head's runs too if such a project ever wants a record.
    const sha = short(live.merge_commit_sha), ci = ghApi(`repos/${pr.repo}/actions/runs?head_sha=${live.merge_commit_sha}&per_page=100`), runs = ci.json?.workflow_runs ?? [];
    const red = runs.filter((w) => w.conclusion === "failure"), stuck = runs.filter((w) => w.status === "completed" && !OK.includes(w.conclusion));
    if (!ci.ok) return [null, `CI at ${sha} unread: ${ci.message}`];
    if (red.length) return [false, `CI is red at ${sha}: ${red.map((w) => w.name).join(", ")}`];
    if (!runs.length) return [null, `no CI ran at ${sha}`];
    if (runs.some((w) => w.status !== "completed")) return [null, `CI at ${sha} hasn't finished`];
    return stuck.length ? [null, `CI at ${sha} reached no result: ${stuck.map((w) => `${w.name} ${w.conclusion}`).join(", ")}`] : [true, `merged at ${short(d.head)}, and CI is green at ${sha}`];
  };
  const counted = [];
  for (const { id, d, pr } of ended) {
    const [agrees, why] = judge(d, pr);
    if (agrees !== null) counted.push(agrees);
    console.log(`${id} PR #${pr.number}: ${agrees === null ? "not counted" : agrees ? "agrees" : "disagrees"}: ${why}`);
  }
  const last = counted.slice(-10), agree = counted.filter(Boolean).length;
  console.log(`RECORD ${last.filter(Boolean).length} of the last ${last.length} counted agree (${agree} agree, ${counted.length - agree} disagree, ${ended.length - counted.length} not counted)`);
  process.exit(0);
}

const ctx = runContext(), s = readJson(ctx.state), wt = ctx.worktree, dir = ctx.runDir;
const config = readJson(path.join(ctx.MAIN, ".factory", "config.json"), {}), recipe = readJson(path.join(wt, ".factory", "setup.json"), {});
const at = (f) => path.join(dir, f), read = (f) => { try { return fs.readFileSync(at(f), "utf8"); } catch { return ""; } }, json = (f) => readJson(at(f));
const head = git(wt, "rev-parse", "HEAD");
// A PR the factory merged stays merged: deciding again, on a resume, keeps that decision and never merges twice.
const done = json("decision.json");
if (done?.merged) {
  console.log(`DECISION merge (${done.mode}) at ${short(done.head)}\nMERGED ${done.merged}: PR #${json("pr.json")?.number}\ndecision.json: ${at("decision.json")}`);
  process.exit(0);
}
const facts = [];
const fact = (name, ok, detail, evidence) => facts.push({ name, ok: !!ok, detail, evidence });

// The live base, or the copy of it fetched last when origin can't be reached now, which not_behind_base then can't vouch for.
let base, unfetched = null;
try { base = liveBase(wt, s.base_branch); } catch (e) {
  unfetched = gitError(e);
  base = [`refs/remotes/origin/${s.base_branch}`, `refs/heads/${s.base_branch}`].find((r) => { try { git(wt, "rev-parse", "--verify", r); return true; } catch { return false; } });
  if (!base) { console.error(`merge-decision: no base branch ${s.base_branch} here or on origin: ${unfetched}`); process.exit(2); }
}
const mergeBase = git(wt, "merge-base", base, "HEAD"), diffAt = `git diff ${short(mergeBase)}..${short(head)}`;
// [status, path] for each file the run changes under `paths`
const diff = (paths) => git(wt, "-c", "core.quotePath=false", "diff", "--no-renames", "--name-status", mergeBase, "HEAD", "--", ...paths)
  .split("\n").filter(Boolean).map((l) => l.split("\t"));
const changed = diff(PRODUCT);
const triage = (() => { try { return JSON.parse([...read("triage.md").matchAll(/```json\s*\n([\s\S]*?)\n```/g)].at(-1)[1]); } catch { return {}; } })();
const tickets = fs.existsSync(at("tickets")) ? fs.readdirSync(at("tickets")).filter((f) => /^\d{2}-.+\.md$/.test(f)).map((f) => f.slice(0, 2)) : [];
// Files pinned to a head, held only when they're of this one.
const pinned = (f) => { const j = json(f); return j?.head === head ? j : null; };
const stale = (f) => `${f} ${json(f) ? `is of ${short(json(f).head)}, not HEAD ${short(head)}` : "is missing"}`;
const touches = pinned("touches.json"), security = pinned("security.json");

const ev = json("evidence.json");
fact("evidence_green_at_head", ev?.sha === head && ev.green === true, ev
  ? `evidence.json at ${short(ev.sha)} (HEAD ${short(head)}): green=${ev.green} dirty=${ev.dirty} trusted=${ev.trusted}${(ev.checks || []).filter((c) => c.status !== "pass").map((c) => `, ${c.app}/${c.check}=${c.status}`).join("")}`
  : "no evidence.json", [at("evidence.json")]);

// ci.json is ci-watch's: green, or a flake whose re-run passed, at HEAD.
const ci = json("ci.json");
fact("ci_green_at_head", ci?.sha === head && ["green", "flake"].includes(ci.cause), ci ? `CI ${ci.cause} at ${short(ci.sha)} (HEAD ${short(head)})` : "no ci.json: CI wasn't read", [at("ci.json")]);

// Every criterion of the spec passes in each ticket's qa walk that names it. A oneshot has no spec: its one criterion is
// triage's acceptance check, which qa walks as `acceptance` (#24).
const oneshot = s.route === "oneshot";
const criteria = oneshot ? ["acceptance"] : [...read("spec.md").matchAll(/^- \*\*(SC-\d{3})\*\*/gm)].map((m) => m[1]);
const walks = tickets.map((n) => `tickets/${n}/qa.json`), results = walks.flatMap((f) => json(f)?.criteria || []);
const unproven = criteria.map((id) => [id, results.filter((c) => c.id === id).map((c) => c.status)])
  .filter(([, st]) => !st.length || st.some((x) => x !== "pass")).map(([id, st]) => `${id}=${st.join("/") || "not walked"}`);
fact("criteria_pass", criteria.length && !unproven.length, criteria.length ? unproven.join(", ") || `${criteria.length} criteria pass` : "spec.md has no SC-### criterion",
  [at(oneshot ? "triage.md" : "spec.md"), ...walks.map(at)]);

const review = json("findings.json"), open = (review?.findings || []).filter((f) => f.status === "open");
const blocking = open.filter((f) => f.severity === "P0" || (f.action === "ask" && f.lens?.includes("human")) || (f.severity === "P1" && f.action !== "note"));
fact("findings_ship", review?.disposition === "ship" && !blocking.length, review
  ? `disposition ${review.disposition}${blocking.map((f) => `, ${f.id} ${f.severity} ${f.action}`).join("")}` : "no findings.json: run synthesize.mjs", [at("findings.json")]);

const REQUIRED = ["secrets", "vulnerabilities", "sast"];
const high = (security?.items || []).filter((i) => ["high", "critical"].includes(i.severity));
const unmet = REQUIRED.filter((c) => !["pass", "partial"].includes(security?.capabilities?.[c]?.status));
fact("security_clear", security && !high.length && !unmet.length, security
  ? [...high.map((i) => `${i.severity} ${i.rule} at ${i.location}`), ...unmet.map((c) => `${c} ${security.capabilities?.[c]?.status ?? "missing"}`)].join(", ")
    || REQUIRED.map((c) => `${c} ${security.capabilities[c].status}`).join(", ")
  : stale("security.json"), [at("security.json")]);

const shots = (json("captures/states.json")?.captures || []).filter((c) => c.file);
fact("captures_if_ui", touches && (!touches.touches.ui?.hit || shots.length), touches ? `ui ${touches.touches.ui?.hit ? "fired" : "didn't fire"}, ${shots.length} captures` : stale("touches.json"),
  [at("touches.json"), at("captures/states.json")]);

// A scaffold run may create the recipe; nothing else the run changes may be one of the paths no run may change alone.
const locked = changed.filter(([st, f]) => LOCKED.test(f.toLowerCase()) && !(s.scaffold === true && st === "A" && f === ".factory/setup.json"));
fact("no_protected_paths", !locked.length, locked.map(([, f]) => f).join(", ") || "none", [diffAt]);

const limit = config.merge_limits?.max_files ?? 40;
fact("files_within_limit", changed.length <= limit, `${changed.length} files changed (limit ${limit})`, [diffAt]);

// An approval covers the head it was given at: a commit since may add a migration nobody approved.
const migrations = touches?.touches.migrations, approved = s.approvals?.migrations;
fact("no_migrations_unless_approved", touches && (!migrations?.hit || (triage.type === "maintenance" && approved?.sha === head)), !touches ? stale("touches.json")
  : !migrations?.hit ? "none" : `migrations on a ${triage.type ?? "untyped"} run, ${!approved ? "not approved"
    : approved.sha === head ? `approved by ${approved.by}` : `approved by ${approved.by} at ${short(approved.sha)}, not HEAD ${short(head)}`}`,
  [at("touches.json"), ctx.state]);

fact("size_not_l", triage.size && triage.size !== "l", `size ${triage.size ?? "missing from triage.md"}`, [at("triage.md")]);

const behind = Number(git(wt, "rev-list", "--count", `HEAD..${base}`));
fact("not_behind_base", !unfetched && behind === 0, unfetched ? `${s.base_branch} couldn't be fetched: ${unfetched}`
  : behind ? `${behind} commit${behind > 1 ? "s" : ""} on ${base} not in HEAD: sync-base.mjs before-merge` : `up to date with ${base}`, [base]);

// Each implementer's last assessment: every ticket's, and a review or CI fix round's.
const reports = [...tickets.map((n) => `tickets/${n}/implementation.md`), ...["review-fix.md", "ci-fix.md"].filter((f) => fs.existsSync(at(f)))];
const doubts = reports.flatMap((f) => {
  const block = [...read(f).matchAll(/^assessment:[ \t]*\n((?:[ \t]+\S.*(?:\n|$))+)/gm)].at(-1)?.[1] ?? "";
  const val = (k) => block.match(new RegExp(`^\\s*${k}:[ \\t]*(.*?)[ \\t]*$`, "m"))?.[1] ?? "";
  return val("recommendation") === "merge" && val("confident") === "true" && val("reason") ? []
    : [`${f}: ${block ? `${val("recommendation") || "no recommendation"}, confident ${val("confident") || "unsaid"}${val("reason") ? "" : ", no reason"}` : "no assessment"}`];
});
fact("implementer_confident", reports.length && !doubts.length, reports.length ? doubts.join("; ") || `${reports.length} assessments: merge, confident, with a reason` : "no implementer report",
  reports.map(at));

const cap = config.caps?.dispatches_per_run ?? 30;
fact("under_dispatch_cap", s.dispatches.length < cap, `${s.dispatches.length} dispatches (cap ${cap})`, [ctx.state]);
const lifted = Object.keys(s.overrides || {});
fact("no_cap_overrides", !lifted.length, lifted.length ? `a human lifted ${lifted.join(", ")}` : "none", [ctx.state]);

// A github-deployment preview of each app the diff touches, ready at HEAD in preview's preview.json.
const touched = (recipe.apps || []).filter((a) => changed.some(([, f]) => [".", ""].includes(a.path ?? ".") || f.startsWith(`${a.path.replace(/\/+$/, "")}/`)));
const deploys = touched.filter((a) => recipe.preview?.[a.name]?.mode === "github-deployment"), previews = json("preview.json")?.apps || {};
const unready = deploys.filter((a) => previews[a.name]?.status !== "ready" || previews[a.name]?.sha !== head);
fact("previews_ready", !unready.length, deploys.length ? unready.map((a) => `${a.name} ${previews[a.name]?.status ?? "missing"} at ${short(previews[a.name]?.sha)}`).join(", ")
  || deploys.map((a) => `${a.name} ready`).join(", ") : "no touched app has a deployment preview", [at("preview.json")]);

// The PR as GitHub has it now, over REST: into the recorded target, at the head evaluated here.
const pr = json("pr.json");
let live = null, why = "no pr.json: no PR is open";
if (pr) {
  const r = ghApi(`repos/${pr.repo}/pulls/${pr.number}`);
  live = r.ok ? r.json : null;
  why = live ? `PR #${pr.number} into ${live.base?.ref} at ${short(live.head?.sha)} (the run: ${s.target_branch} at ${short(head)})` : `PR #${pr.number} unread over REST: ${r.message}`;
}
fact("pr_targets_target", live?.base?.ref === s.target_branch && live?.head?.sha === head, why, [at("pr.json")]);

// #15's facts, each of which alone sends the run to a human: what a revert can't fully undo.
const hit = touches ? ["auth", "crypto"].filter((t) => touches.touches[t]?.hit) : [];
fact("no_auth_or_crypto", touches && !hit.length, touches ? hit.map((t) => `${t} fired at ${(touches.touches[t].paths || []).join(", ") || (touches.touches[t].patterns || []).join(", ")}`).join("; ") || "neither fired"
  : stale("touches.json"), [at("touches.json")]);
fact("no_new_env", touches && !touches.new_env?.length, touches ? touches.new_env?.length ? `the diff reads ${touches.new_env.join(", ")}` : "none" : stale("touches.json"), [at("touches.json")]);
const deps = security?.new_dependencies || [];
fact("no_new_dependency", security && !deps.length, security ? deps.map((d) => `${d.name}@${d.spec} in ${d.package}`).join(", ") || "none" : stale("security.json"), [at("security.json")]);
// From the diff, never qa.json, so qa never labels its own edits; a pinned test the run adds is fine.
const dirs = [].concat(recipe.pinned ?? []).map((d) => String(d).replace(/\/+$/, ""));
const edited = dirs.length ? diff(dirs).filter(([st]) => st !== "A") : [];
fact("no_pinned_test_changed", !edited.length, edited.map(([st, f]) => `${f} ${st === "D" ? "deleted" : "modified"}`).join(", ") || `none in ${dirs.join(", ") || "no pinned directory"}`, [diffAt]);
// #24: a oneshot changes one product file, a constant and not a config key; tests (classify-diff's) and the pinned
// directories don't count.
// ponytail: touches.json lists 20 test paths at most, so a 21st counts as product and the run goes to a human; read the
// touch rules here if a oneshot ever changes more tests than that.
const tests = touches?.touches.tests?.paths || [];
const product = changed.map(([, f]) => f).filter((f) => !tests.includes(f) && !dirs.some((d) => f.startsWith(`${d}/`)));
fact("oneshot_scope", !oneshot || (touches && product.length <= 1), !oneshot ? `a ${s.route} run` : !touches ? stale("touches.json")
  : `${product.length} product file${product.length === 1 ? "" : "s"} on a oneshot${product.length ? `: ${product.join(", ")}` : ""}`, [at("touches.json"), diffAt]);
// #17: a run verifies a mobile app on one platform, so what it couldn't verify is the human's: a mobile criterion qa
// found nothing here could observe (no device, a universal link), a mobile check skipped, and native code of a platform
// it didn't run on.
const mobiles = (recipe.apps || []).filter((a) => a.type === "mobile").map((a) => a.name), on = PLATFORM_NAMES[ev?.platform];
const unrun = [...results.filter((c) => mobiles.includes(c.app) && c.status === "blocked" && c.reason === "environment").map((c) => `${c.id} blocked (environment)`),
  ...(ev?.checks || []).filter((c) => mobiles.includes(c.app) && c.status === "skipped").map((c) => `${c.app}/${c.check} skipped: ${String(c.digest).split("\n")[0]}`)];
fact("mobile_verified", !unrun.length, !mobiles.length ? "no mobile app" : unrun.join(", ") || (on ? `verified on ${on}` : "no device, and nothing needed one"),
  [at("evidence.json"), ...walks.map(at)]);
const unverified = unverifiedNative(recipe, ev?.platform ?? null, changed.map(([, f]) => f));
fact("no_unverified_native", !unverified.length, unverified.map((u) => `${u.files.join(", ")} change${u.files.length === 1 ? "s" : ""} ${PLATFORM_NAMES[u.platform]}'s native code, `
  + `which the run didn't verify (${on ? `it verified on ${on}` : "it had no device"})`).join("; ") || "none", [at("evidence.json"), diffAt]);
const branching = config.branching || {};
// A run stacked on another entry's open PR merges after it, into the trunk, never into that PR's branch (#81).
fact("not_stacked", !s.stack, s.stack ? `stacked on ${s.stack.branch}${s.stack.pr ? ` (PR #${s.stack.pr})` : ""}, which merges first` : "on its trunk", [at("state.json")]);
fact("not_git_flow_main", !(branching.model === "git-flow" && s.target_branch === (branching.main || "main")),
  `${branching.model || "trunk"}, targeting ${s.target_branch}`, [path.join(ctx.MAIN, ".factory", "config.json")]);

// auto acts as trial while a factory revert PR (post-merge's, on revert/<run>-<sha>) is open in the repo, so nothing merges
// onto a target a revert is mending; open PRs GitHub won't list can't vouch that none is (#15). One REST query.
// ponytail: one page of the 100 newest open PRs; page through them if a repo ever keeps more open than that.
let mode = config.merge === "auto" ? "auto" : "trial", paused = null;
if (mode === "auto" && pr) {
  const r = ghApi(`repos/${pr.repo}/pulls?state=open&per_page=100`);
  const revert = r.ok && (r.json || []).find((p) => p.head?.ref?.startsWith("revert/") && (p.labels || []).some((l) => l.name === "factory"));
  paused = !r.ok ? `the open PRs couldn't be read: ${r.message}` : revert ? `revert PR #${revert.number} is open` : null;
  if (paused) mode = "trial";
}
// In auto, a merge decision merges, over REST at the head evaluated here, by the configured method: GitHub refuses a head
// pushed since (409) and whatever branch protection or a ruleset still wants, REST having no --admin. A refusal is one
// more fact, GitHub's message quoted (docs/platform-facts.md, facts 18 and 19).
let merged = null;
if (mode === "auto" && facts.every((f) => f.ok)) {
  const method = config.merge_method || "merge";
  const r = ghApi("-X", "PUT", `repos/${pr.repo}/pulls/${pr.number}/merge`, "-f", `sha=${head}`, "-f", `merge_method=${method}`);
  merged = r.ok && r.json?.merged === true ? r.json.sha : null;
  fact("merged", merged, merged ? `PR #${pr.number} merged at ${short(merged)} by ${method}` : `GitHub refused to merge PR #${pr.number} at ${short(head)}: "${r.message}"`, [at("pr.json")]);
}
const failed = facts.filter((f) => !f.ok);
// In auto, a run behind its base and nothing else gets one catch-up: the orchestrator merges the base in (sync-base
// before-merge, update-branch on the PR), verifies the new head and decides again. The ask is catch-up.json, so the
// decision after it never asks again, and until then there's no decision, so the PR stage says nothing on the PR. In
// trial, behind is reported, as every failing fact is.
if (mode === "auto" && failed.length === 1 && failed[0].name === "not_behind_base" && !unfetched && !fs.existsSync(at("catch-up.json"))) {
  fs.writeFileSync(at("catch-up.json"), JSON.stringify({ head, base: git(wt, "rev-parse", base) }, null, 2) + "\n");
  fs.rmSync(at("decision.json"), { force: true });
  console.log(`CATCH-UP ${behind} commit${behind > 1 ? "s" : ""} on ${base} not in HEAD: sync-base.mjs before-merge, verify --full, then decide again`);
  process.exit(0);
}
const decision = { run: ctx.id, head, mode, ...(paused && { paused }), decision: failed.length ? "needs-human" : "merge", reasons: failed.map((f) => `${f.name}: ${f.detail}`), facts,
  ...(merged && { merged }), decided_at: new Date().toISOString() };
fs.writeFileSync(at("decision.json"), JSON.stringify(decision, null, 2) + "\n");
console.log([`DECISION ${decision.decision} (${mode}) at ${short(head)}`, ...decision.reasons.map((r) => `  - ${r}`), ...(paused ? [`auto acts as trial: ${paused}`] : []),
  ...(merged ? [`MERGED ${merged}: PR #${pr.number}`] : []), `decision.json: ${at("decision.json")}`].join("\n"));
