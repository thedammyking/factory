#!/usr/bin/env node
// merge-decision.mjs — writes the run's decision.json: merge only when every fact below holds at the run head, else
// needs-human with each fact that doesn't, as `<fact>: <what it read>`, the files that show it beside it. Facts, never an
// agent's judgement. Takes --run <id>, or derives the run from the run worktree it runs in.
//   - The diff is the run's from its merge base with lib's live base (design fix 21), the factory's bookkeeping left out
//     (design fix 2): the base's own commits are never the run's.
//   - A run file a fact reads that's missing, or was written at another head, never lets it hold: unknown is no pass.
//   - The mode is config.merge, trial unless it says auto. Nothing here merges.
// Prints `DECISION <merge|needs-human> (<mode>) at <sha>`, then each failing fact.
import fs from "node:fs";
import path from "node:path";
import { readJson, git, gitError, runContext, liveBase, ghApi, PRODUCT, LOCKED } from "./lib.mjs";

const ctx = runContext(), s = readJson(ctx.state), wt = ctx.worktree, dir = ctx.runDir;
const config = readJson(path.join(ctx.MAIN, ".factory", "config.json"), {}), recipe = readJson(path.join(wt, ".factory", "setup.json"), {});
const at = (f) => path.join(dir, f), read = (f) => { try { return fs.readFileSync(at(f), "utf8"); } catch { return ""; } }, json = (f) => readJson(at(f));
const head = git(wt, "rev-parse", "HEAD"), short = (sha) => String(sha ?? "none").slice(0, 7);
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

// Every criterion of the spec passes in each ticket's qa walk that names it.
const criteria = [...read("spec.md").matchAll(/^- \*\*(SC-\d{3})\*\*/gm)].map((m) => m[1]);
const walks = tickets.map((n) => `tickets/${n}/qa.json`), results = walks.flatMap((f) => json(f)?.criteria || []);
const unproven = criteria.map((id) => [id, results.filter((c) => c.id === id).map((c) => c.status)])
  .filter(([, st]) => !st.length || st.some((x) => x !== "pass")).map(([id, st]) => `${id}=${st.join("/") || "not walked"}`);
fact("criteria_pass", criteria.length && !unproven.length, criteria.length ? unproven.join(", ") || `${criteria.length} criteria pass` : "spec.md has no SC-### criterion",
  [at("spec.md"), ...walks.map(at)]);

const review = json("findings.json"), open = (review?.findings || []).filter((f) => f.status === "open");
const blocking = open.filter((f) => f.action === "ask" || (["P0", "P1"].includes(f.severity) && f.action === "fix"));
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

// Each implementer's last assessment: every ticket's, and a review fix round's.
const reports = [...tickets.map((n) => `tickets/${n}/implementation.md`), ...(fs.existsSync(at("review-fix.md")) ? ["review-fix.md"] : [])];
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
const branching = config.branching || {};
fact("not_git_flow_main", !(branching.model === "git-flow" && s.target_branch === (branching.main || "main")),
  `${branching.model || "trunk"}, targeting ${s.target_branch}`, [path.join(ctx.MAIN, ".factory", "config.json")]);

const failed = facts.filter((f) => !f.ok), mode = config.merge === "auto" ? "auto" : "trial";
const decision = { run: ctx.id, head, mode, decision: failed.length ? "needs-human" : "merge", reasons: failed.map((f) => `${f.name}: ${f.detail}`), facts, decided_at: new Date().toISOString() };
fs.writeFileSync(at("decision.json"), JSON.stringify(decision, null, 2) + "\n");
console.log([`DECISION ${decision.decision} (${mode}) at ${short(head)}`, ...decision.reasons.map((r) => `  - ${r}`), `decision.json: ${at("decision.json")}`].join("\n"));
