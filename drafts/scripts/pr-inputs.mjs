#!/usr/bin/env node
// pr-inputs.mjs [--run <id>] -> pr-inputs.json : everything the PR writer needs, pre-extracted, so it formats instead of reads.
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const ROOT = (() => { let d = process.cwd(); while (!fs.existsSync(path.join(d, ".factory")) && path.dirname(d) !== d) d = path.dirname(d); return d; })();
const runIdx = process.argv.indexOf("--run");
const runId = runIdx > -1 ? process.argv[runIdx + 1] : fs.readFileSync(path.join(ROOT, ".factory/runs/ACTIVE"), "utf8").trim();
const RUN = path.join(ROOT, ".factory/runs", runId);
const rt = (f) => { try { return fs.readFileSync(path.join(RUN, f), "utf8"); } catch { return ""; } };
const rj = (f, d = null) => { try { return JSON.parse(rt(f)); } catch { return d; } };
const sh = (c) => { try { return execSync(c, { cwd: ROOT, encoding: "utf8" }).trim(); } catch { return ""; } };
const section = (md, h) => (md.match(new RegExp(`^## ${h}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`, "m")) || [])[1]?.trim() || "";

const spec = rt("spec.md"), impl = rt("implementation.md"), state = rj("state.json", {}), evidence = rj("evidence.json", {});
const qa = rj("qa.json", {}), findings = rj("findings.json", { findings: [] }), security = rj("security.json", {}), setup = JSON.parse(fs.readFileSync(path.join(ROOT, ".factory/setup.json"), "utf8"));
const preview = rj("preview.json", null);
const title = (spec.match(/^#\s+(.+)$/m) || [])[1] || state.slug;
const sc = [...spec.matchAll(/^-\s*\*?\*?(SC-\d{3})\*?\*?[:.\s]+(.+)$/gm)].map(m => ({ id: m[1], text: m[2].replace(/\s+/g, " ").slice(0, 220) }));
const qaById = Object.fromEntries((qa.criteria || []).map(c => [c.id, c]));
const assumptions = (impl.match(/assumptions:\n([\s\S]*?)\nassessment:/) || [])[1]?.trim() || "";
const assessment = (impl.match(/assessment:\n([\s\S]*?)$/) || [])[1]?.trim() || "";
const captures = fs.existsSync(path.join(RUN, "captures")) ? fs.readdirSync(path.join(RUN, "captures")).filter(f => f.endsWith(".png")) : [];
const pick = ["SC-006-after.png", "SC-008-after.png", "SC-009-after.png", "SC-010c-after.png", "state-card-dark-390.png", "state-card-light-1440.png"].filter(f => captures.includes(f));

const out = {
  run: runId, title, ticket_key: (state.slug || "").toUpperCase().replace(/[^A-Z0-9]+/g, "-").slice(0, 12), branch: state.branch, target_branch: state.target_branch,
  labels: ["factory", ...(findings.disposition !== "ship" ? ["needs-human"] : [])],
  summary: section(spec, "Goal").split("\n").slice(0, 6).join("\n"),
  commits: sh(`git log --oneline ${state.base_sha}..HEAD -- apps`).split("\n").filter(Boolean),
  diff_stat: sh(`git diff --shortstat ${state.base_sha}..HEAD -- apps`),
  evidence: { sha: evidence.sha, green: evidence.green, dirty: evidence.dirty, trusted: evidence.trusted,
    checks: (evidence.checks || []).map(c => ({ app: c.app, check: c.check, status: c.status, seconds: c.seconds })) },
  criteria: sc.map(s => ({ id: s.id, text: s.text, status: qaById[s.id]?.status || "not-walked", evidence: (qaById[s.id]?.evidence || []).slice(0, 2) })),
  analytics: (qa.analytics?.verdicts || []).map(v => ({ event: v.event, verdict: v.verdict })),
  review: { disposition: findings.disposition, counts: findings.counts,
    open_decisions: findings.findings.filter(f => f.status === "open" && f.action === "ask").map(f => ({ id: f.id, severity: f.severity, claim: f.claim.slice(0, 240), location: f.location.slice(0, 80) })),
    resolved: findings.findings.filter(f => f.status === "resolved").map(f => ({ id: f.id, severity: f.severity, claim: f.claim.slice(0, 160) })),
    pr_findings: findings.findings.filter(f => f.status === "pr").map(f => ({ id: f.id, severity: f.severity, claim: f.claim.slice(0, 160), location: f.location.slice(0, 80) })) },
  security: { capabilities: (security.capabilities || []).map(c => `${c.capability}=${c.status}(${c.tool})`), client_exposed_env: security.client_exposed_env, new_dependencies: security.new_dependencies },
  assumptions_verbatim: assumptions, assessment_verbatim: assessment,
  screenshots: pick.map(f => `captures/${f}`),
  preview: preview, verify_locally: {
    checkout: `git fetch && git checkout ${state.branch} && pnpm install --frozen-lockfile`,
    apps: (setup.apps || []).map(a => ({ name: a.name, start: setup.preview?.local?.[a.name]?.command, url: setup.preview?.local?.[a.name]?.url })),
    note: "API default rate limit is 10/min per IP; start it with RATE_LIMIT_MAX=1000 for a walkthrough." },
};
fs.writeFileSync(path.join(RUN, "pr-inputs.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`PR-INPUTS ${Buffer.byteLength(JSON.stringify(out))} bytes · ${out.criteria.length} SC · ${out.commits.length} commits · ${out.review.open_decisions.length} open decisions · ${out.screenshots.length} screenshots`);
