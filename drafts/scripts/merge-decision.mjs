#!/usr/bin/env node
// merge-decision.mjs [--run <id>] -> decision.json
// Hard facts only. The agent's single input is implementation.md's assessment block (recommendation + confidence + reason).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = (() => { let d = process.cwd(); while (!fs.existsSync(path.join(d, ".factory")) && path.dirname(d) !== d) d = path.dirname(d); return d; })();
const runIdx = process.argv.indexOf("--run");
const runId = runIdx > -1 ? process.argv[runIdx + 1] : fs.readFileSync(path.join(ROOT, ".factory/runs/ACTIVE"), "utf8").trim();
const RUN = path.join(ROOT, ".factory/runs", runId);
const rj = (f, d = null) => { try { return JSON.parse(fs.readFileSync(path.join(RUN, f), "utf8")); } catch { return d; } };
const rt = (f) => { try { return fs.readFileSync(path.join(RUN, f), "utf8"); } catch { return ""; } };
// git with an argument list: branch names and SHAs come from state.json (triage output) and never pass through a shell.
const git = (...a) => { try { return execFileSync("git", a, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } };
const config = JSON.parse(fs.readFileSync(path.join(ROOT, ".factory/config.json"), "utf8"));
const state = rj("state.json", {});
const evidence = rj("evidence.json", {});
const qa = rj("qa.json", {});
const security = rj("security.json", { findings: [] });
const review = rt("review.md");
const touches = rj("touches.json", { touches: {} }).touches;
const impl = rt("implementation.md");

const facts = [];
const fact = (name, ok, detail) => facts.push({ name, ok: !!ok, detail });

const head = git("rev-parse", "HEAD");
fact("evidence_pinned_to_head", evidence.sha === head, `${(evidence.sha || "").slice(0, 7)} vs ${head.slice(0, 7)}`);
fact("evidence_clean", evidence.dirty === false, evidence.dirty ? "tree dirty or HEAD moved during verify" : "clean");
fact("evidence_trusted", evidence.trusted === true, evidence.trusted ? "recipe unchanged" : "recipe differs from committed");
fact("all_checks_pass", (evidence.checks || []).length > 0 && evidence.checks.every(c => c.status === "pass"),
  (evidence.checks || []).filter(c => c.status !== "pass").map(c => `${c.app}/${c.check}=${c.status}`).join(", ") || "all pass");
const crit = qa.criteria || [];
fact("every_criterion_passed", crit.length > 0 && crit.every(c => c.status === "pass"), crit.map(c => `${c.id}=${c.status}`).join(" ") || "no qa.json");
// Findings are read from findings.json (written by synthesize.mjs), never from prose.
const findings = rj("findings.json", null);
fact("findings_json_present", !!findings, findings ? `${findings.findings.length} findings` : "run synthesize.mjs");
const openBlock = findings ? findings.findings.filter(f => f.status === "open" && ["P0", "P1"].includes(f.severity) && f.action === "fix") : [];
const openAsks = findings ? findings.findings.filter(f => f.status === "open" && f.action === "ask") : [];
fact("review_disposition_ship", findings?.disposition === "ship", `disposition: ${findings?.disposition ?? "unknown"}`);
fact("no_open_p0_p1", findings ? openBlock.length === 0 : false, openBlock.map(f => `${f.id}(${f.severity})`).join(", ") || "none open");
fact("no_ask_findings", findings ? openAsks.length === 0 : false, openAsks.map(f => f.id).join(", ") || "none");
const sec = (security.findings || []).filter(f => /high|critical/i.test(f.severity || ""));
fact("no_high_security", sec.length === 0, sec.map(f => f.id || f.rule).join(", ") || "none");
// Required capabilities must each have a passing tool; `partial` (e.g. registry packs unreachable) passes with a note,
// `optional` never blocks, `missing`/`fail` block.
const caps = security.capabilities || [];
const required = ["secrets", "vulnerabilities", "sast-project-rules"];
const bad = caps.filter(c => (required.includes(c.capability) && !["pass", "partial"].includes(c.status)) || c.status === "fail");
const absent = required.filter(r => !caps.some(c => c.capability === r));
fact("security_scanners_ran", caps.length > 0 && bad.length === 0 && absent.length === 0,
  [...bad.map(c => `${c.capability}=${c.status}(${c.tool})`), ...absent.map(r => `${r}=absent`)].join(", ") ||
  "required capabilities passed" + (caps.some(c => c.status === "partial") ? " (partial: " + caps.filter(c => c.status === "partial").map(c => c.capability).join(",") + ")" : ""));
const uiTouched = touches.ui?.hit;
const captures = fs.existsSync(path.join(RUN, "captures")) ? fs.readdirSync(path.join(RUN, "captures")).length : 0;
fact("captures_if_ui", !uiTouched || captures > 0, `ui=${!!uiTouched} captures=${captures}`);
// Protected paths: CI workflows, lint/format config, the recipe. Factory scripts live in the plugin, not the repo, so they are
// not part of the product diff (in this dry run they are vendored under .factory/scripts/ and excluded here for the same reason).
// The one sanctioned exception: a scaffold run (state.scaffold === true) may create .factory/setup.json.
// The product diff is what the PR shows: HEAD against the merge-base with the CURRENT base branch (after a before-merge sync
// the recorded base_sha is behind, and a diff from it would blame the feature for files that arrived from the base).
const baseRef = git("rev-parse", "--verify", "-q", `origin/${state.base_branch || "develop"}`) ? `origin/${state.base_branch || "develop"}` : (state.base_branch || "develop");
const mergeBase = git("merge-base", baseRef, "HEAD") || state.base_sha;
const protectedTouched = (git("diff", "--name-only", `${mergeBase}..HEAD`) || "").split("\n").filter(f =>
  /^\.github\/workflows\//.test(f) || (f === ".factory/setup.json" && state.scaffold !== true) || /eslint|prettier|biome/.test(f));
fact("no_protected_paths", protectedTouched.length === 0, protectedTouched.join(", ") || "none");
fact("size_not_large", state.size !== "l", `size=${state.size}`);
const behind = Number(git("rev-list", "--count", `HEAD..${baseRef}`) || 0);
fact("not_behind_base", behind === 0, behind ? `${behind} commit(s) on ${baseRef} not in HEAD (run sync-base.sh before-merge)` : `up to date with ${baseRef}`);
// implementation.md gains a status block per round; the implementer's assessment is the LAST one, not the first.
const m = [...impl.matchAll(/recommendation:\s*(\w+)[\s\S]*?confident:\s*(true|false)[\s\S]*?reason:\s*(.+)/gi)].pop();
fact("implementer_confident_with_reason", !!m && m[1].toLowerCase() === "merge" && m[2] === "true" && m[3].trim().length > 10,
  m ? `${m[1]}/${m[2]}: ${m[3].trim().slice(0, 80)}` : "no assessment block in implementation.md");
fact("under_dispatch_cap", (state.dispatches || []).length < (config.caps?.dispatches_per_run ?? 30), `${(state.dispatches || []).length} dispatches`);
// A run that needed a human to lift a cap is never auto-mergeable: the human who lifted it decides.
const ov = Object.keys(state.overrides || {});
fact("no_cap_overrides", ov.length === 0, ov.length ? `human overrode: ${ov.join(", ")}` : "none");
// CI classification from ci-watch (when the run has one): green or flake pass; ours/inherited/infra do not.
const ci = rj("ci.json", null);
fact("ci_green_at_head", !!ci && ci.sha === head && ["green", "flake"].includes(ci.cause), ci ? `${ci.cause} @${(ci.sha || "").slice(0, 7)}` : "no ci.json");

const failing = facts.filter(f => !f.ok);
const decision = { run: runId, head, mode: config.merge || "trial", decision: failing.length ? "needs-human" : "merge",
  reasons: failing.map(f => `${f.name}: ${f.detail}`), facts };
fs.writeFileSync(path.join(RUN, "decision.json"), JSON.stringify(decision, null, 2) + "\n");
console.log(`DECISION ${decision.decision} (mode=${decision.mode})` + (failing.length ? "\n  - " + decision.reasons.join("\n  - ") : ""));
