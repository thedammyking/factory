#!/usr/bin/env node
// pr-render.mjs [--run <id>] -> pr.md rendered from pr-inputs.json. Zero tokens. An agent is only needed for prose polish, if ever.
import fs from "node:fs";
import path from "node:path";
import { runContext } from "./lib.mjs";

const { RUN } = runContext();
const p = JSON.parse(fs.readFileSync(path.join(RUN, "pr-inputs.json"), "utf8"));
const flag = (b) => (b ? "yes" : "no");
const step = (c) => {
  // "open <route>, do X, expect Y": derive route from the criterion text when it names one, else the web root
  const route = (c.text.match(/(?:^|[\s`(])(\/(?!\/)[\w/?=&.-]*)/) || [])[1] || "/";  // a bare route, never the path half of a URL
  const expect = (c.text.match(/(?:expect|shows?|returns?|displays?|see)s?\s+(.{10,120}?)(?:\.|;|$)/i) || [])[1];
  return `${c.id}: open \`${p.verify_base_url || ""}${route}\`; ${c.text.replace(/\s+/g, " ").slice(0, 160)}${expect ? ` → expect ${expect}` : ""}`;
};
const md = `# ${p.ticket_key}: ${p.title}

Target: \`${p.target_branch}\` · Branch: \`${p.branch}\` · Labels: ${p.labels.map(l => `\`${l}\``).join(" ")} · Run: \`${p.run}\`

## Summary
${p.summary}

${p.diff_stat} · ${p.commits.length} commits

## Review
Disposition: **${p.review.disposition}** · P0 ${p.review.counts.P0} · P1 ${p.review.counts.P1} · P2 ${p.review.counts.P2} · P3 ${p.review.counts.P3} · resolved ${p.review.counts.resolved}

### Resolved in fix rounds
${p.review.resolved.map(f => `- ${f.id} (${f.severity}): ${f.claim}`).join("\n") || "- none"}

### Findings left in this PR (not blocking)
${p.review.pr_findings.map(f => `- ${f.id} (${f.severity}) \`${f.location}\`: ${f.claim}`).join("\n") || "- none"}

## Needs a decision
${p.review.open_decisions.map((d, i) => `${i + 1}. **${d.id}** (${d.severity}) \`${d.location}\`\n   ${d.claim}`).join("\n") || "none"}

## Evidence
Evidence sha \`${(p.evidence.sha || "").slice(0, 7)}\` · green: ${flag(p.evidence.green)} · dirty: ${flag(p.evidence.dirty)} · trusted: ${flag(p.evidence.trusted)}

| app | check | status | seconds |
|---|---|---|---|
${p.evidence.checks.map(c => `| ${c.app} | ${c.check} | ${c.status} | ${c.seconds} |`).join("\n")}

| criterion | status | evidence |
|---|---|---|
${p.criteria.map(c => `| ${c.id} | ${c.status} | ${c.evidence.map(e => `\`${e}\``).join(" ") || ""} |`).join("\n")}

## Analytics
${p.analytics.map(a => `- ${a.event}: ${a.verdict}`).join("\n") || "- none specified"}

## Security
${p.security.capabilities.map(c => `- ${c}`).join("\n")}
- client-exposed env: ${p.security.client_exposed_env || "none"}
- new dependencies: ${(p.security.new_dependencies || "").split(" ").filter(Boolean).length}

## Screenshots
${p.screenshots.map(s => `- \`${s}\``).join("\n")}

## Assumptions I made
${p.assumptions_verbatim || "(none recorded)"}

## Implementer assessment
\`\`\`
${p.assessment_verbatim}
\`\`\`

## Verify in 2 minutes
${p.preview.some(a => a.status === "ready") ? p.preview.map(a => `- ${a.name}: ${a.status === "ready" ? a.url : `${a.status}${a.reason ? ` (${a.reason})` : ""}, use the local stack`}`).join("\n") + "\n\nOr locally:" : "No preview is ready; verify locally:"}
\`\`\`
${p.verify_locally.checkout}
${p.verify_locally.apps.map(a => `# ${a.name}: ${a.start}   → ${a.url}`).join("\n")}
\`\`\`
${p.verify_locally.note}

${p.criteria.map((c, i) => `${i + 1}. ${step(c)}`).join("\n")}
`;
fs.writeFileSync(path.join(RUN, "pr.md"), md);
console.log(`PR rendered: ${md.length} chars, ${p.criteria.length} verify steps, ${p.review.open_decisions.length} decisions (0 tokens)`);
