#!/usr/bin/env node
// pr-render.mjs [--merged <sha>] — renders the run's PR from its files, for no tokens (design fix 10). Takes --run <id>, or
// derives the run from the run worktree it runs in.
//   pr.md        the title and body: the spec's goal, each criterion's full text with qa's result, the evidence table,
//                Needs a decision (open asks and P0s, and the facts a needs-human decision failed), the findings, the
//                security capabilities, each implementer's assumptions and assessment verbatim, up to six captures, the
//                pinned tests qa superseded or repaired, the spec's Anti-goals, the Spec line (the Notion page in its
//                frontmatter, else where the snapshot puts it) and Verify in 2 minutes: the local commands, then a step
//                per criterion opening its route, a bare path and never the path half of a URL (design fix 26).
//   comment.md   the decision comment, when there is one: "Merged at <sha>" with --merged, "Would merge (trial)" for a
//                merge decision, the attention item for a needs-human one (written as attention-merge.md too), and the
//                newest attention item of a run stopped needs-human or failed with no decision. Removed when there's
//                nothing to say.
// Run files are named as the snapshot will keep them, under .factory/history/<run>/, so a comment shows no local path.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, arg, runContext, shellQuote as q, attentionItem } from "./lib.mjs";

const merged = arg("--merged");
if (merged !== null && !/^[0-9a-f]{7,40}$/.test(merged)) { console.error("pr-render: --merged takes the merge's SHA"); process.exit(2); }
const ctx = runContext(), s = readJson(ctx.state), dir = ctx.runDir;
const config = readJson(path.join(ctx.MAIN, ".factory", "config.json"), {}), recipe = readJson(path.join(ctx.worktree, ".factory", "setup.json"), {});
const read = (f) => { try { return fs.readFileSync(path.join(dir, f), "utf8"); } catch { return ""; } }, json = (f) => readJson(path.join(dir, f));
const history = `.factory/history/${ctx.id}`, inHistory = (p) => p.startsWith(dir + path.sep) ? `${history}/${path.relative(dir, p)}`
  : p.startsWith(ctx.MAIN + path.sep) && !p.startsWith(ctx.worktree) ? path.relative(ctx.MAIN, p) : p;
const short = (sha) => String(sha ?? "none").slice(0, 7), cell = (t) => String(t).replaceAll("|", "\\|");
const list = (items) => items.length ? items.join("\n") : "- none";

const spec = read("spec.md"), fm = spec.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "", body = spec.replace(/^---\n[\s\S]*?\n---\n/, "");
const section = (h) => body.match(new RegExp(`^## ${h}[ \\t]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m"))?.[1].trim() ?? "";
const title = body.match(/^# (.+)$/m)?.[1].trim() ?? ctx.id;
const criteria = [...body.matchAll(/^- \*\*(SC-\d{3})\*\*(?: \([^)]*\))?:[ \t]*(.+)$/gm)].map(([, id, text]) => ({ id, text: text.trim() }));
const tickets = fs.existsSync(path.join(dir, "tickets")) ? fs.readdirSync(path.join(dir, "tickets")).filter((f) => /^\d{2}-.+\.md$/.test(f)).sort().map((f) => f.slice(0, -3)) : [];
const walks = tickets.map((t) => json(`tickets/${t.slice(0, 2)}/qa.json`)).filter(Boolean);
const result = (id) => [...new Set(walks.flatMap((w) => w.criteria || []).filter((c) => c.id === id).map((c) => c.reason ? `${c.status} (${c.reason})` : c.status))].join(" / ") || "not walked";
const ev = json("evidence.json") || {}, findings = json("findings.json")?.findings || [], security = json("security.json"), pr = json("pr.json");
const decision = json("decision.json"), failed = decision?.facts.filter((f) => !f.ok) ?? [];
const finding = (f) => `- ${f.id} (${f.severity} ${f.action}) \`${f.location}\`: ${f.claim}`;
const asks = findings.filter((f) => f.status === "open" && (f.action === "ask" || f.severity === "P0"));

// A criterion's route: its first bare path once every URL (a scheme's, or protocol-relative) is taken out.
const route = (text) => text.replace(/(?:[a-z][a-z\d+.-]*:)?\/\/[^\s`'")]*/gi, " ").match(/(?:^|[\s`'"(])(\/[^\s`'"),;]*)/)?.[1];
const port = (t) => String(t ?? "").replace(/\{port:[^}]+\}/g, "<port>");
const reports = [...tickets.map((t) => [`Ticket ${t}`, `tickets/${t.slice(0, 2)}/implementation.md`]), ["Review fix", "review-fix.md"]]
  .map(([name, f]) => [name, read(f)]).filter(([, text]) => text).map(([name, text]) => {
    const last = (re) => [...text.matchAll(re)].at(-1)?.[0].trimEnd() ?? "";
    return `### ${name}\n\n\`\`\`text\n${[last(/^assumptions:[ \t]*\n(?:- .*(?:\n|$))+/gm), last(/^assessment:[ \t]*\n(?:[ \t]+\S.*(?:\n|$))+/gm)].filter(Boolean).join("\n") || "no assumptions or assessment"}\n\`\`\``;
  });
const rulings = walks.flatMap((w) => [
  ...(w.superseded || []).map((t) => `- \`${t.test}\`: superseded (was ${t.was}, now ${t.now}): ${t.why}`),
  ...(w.repaired || []).map((t) => `- \`${t.test}\`: repaired (${t.change}): ${t.why}`),
]);
const notion = fm.match(/^notion:[ \t]*(\S+)/m)?.[1];

const md = `# ${title}

${section("Goal")}

Run \`${ctx.id}\`: \`${s.branch}\` into \`${s.target_branch}\`.

## Success criteria
| Criterion | Text | Status |
|---|---|---|
${criteria.map((c) => `| ${c.id} | ${cell(c.text)} | ${cell(result(c.id))} |`).join("\n")}

## Evidence
${ev.sha ? `At \`${short(ev.sha)}\`: green ${ev.green}, dirty ${ev.dirty}, trusted ${ev.trusted}.` : "No evidence.json."}

| Check | Result | Duration | SHA |
|---|---|---|---|
${(ev.checks || []).map((c) => `| ${cell(`${c.app}/${c.check}`)} | ${c.status} | ${c.seconds} s | \`${short(ev.sha)}\` |`).join("\n")}

## Needs a decision
${list([...asks.map(finding), ...(decision?.decision === "needs-human" ? decision.reasons.map((r) => `- ${r}`) : [])]).replace(/^- none$/, "- nothing")}

## Findings
### Open
${list(findings.filter((f) => ["open", "pr"].includes(f.status) && !asks.includes(f)).map(finding))}

### Resolved
${list(findings.filter((f) => f.status === "resolved").map(finding))}

## Security
${security ? Object.entries(security.capabilities).map(([c, x]) => `- ${c}: ${x.status} (${(x.runs || []).find((r) => !r.optional)?.tool ?? "no tool"})`).join("\n") : "- no security.json"}

## Assumptions and assessment
${reports.join("\n\n") || "No implementer report."}

## Captures
${list((json("captures/states.json")?.captures || []).filter((c) => c.file).slice(0, 6).map((c) => `- \`${history}/${c.file}\``))}

## Pinned tests changed
${list(rulings)}

## Anti-goals
${section("Anti-goals") || "- none in the spec"}

Spec: ${notion ?? `\`${history}/spec.md\``}

## Verify in 2 minutes
Locally:

\`\`\`sh
${[`git fetch origin ${q(s.branch)} && git checkout ${q(s.branch)}`, ...(recipe.setup ? [recipe.setup] : []),
  ...(recipe.apps || []).filter((a) => a.dev).map((a) => `${port(a.dev)}   # ${a.name}${a.health ? `, at ${port(a.health)}` : ""}`)].join("\n")}
\`\`\`

${criteria.map((c, i) => `${i + 1}. ${c.id}: ${route(c.text) ? `open \`${route(c.text)}\`; ` : ""}${c.text}`).join("\n")}
`;
fs.writeFileSync(path.join(dir, "pr.md"), md);

// The decision comment, in the factory skill's attention-item shape when a human is needed.
const commentFile = path.join(dir, "comment.md");
let comment = null;
if (merged) comment = `**Merged at \`${merged}\`.** Every fact held at \`${short(decision?.head)}\`: \`${history}/decision.json\`.\n`;
else if (decision?.decision === "merge") comment = `**Would merge (trial).** Every fact holds at \`${short(decision.head)}\`: the ${decision.facts.length} are in \`${history}/decision.json\`. `
  + "In trial the factory merges nothing, so merging it as it is yourself counts toward `auto`.\n";
else if (decision) {
  // run-state as the developer's shell finds it, never naming their home directory in a comment GitHub shows
  const script = fileURLToPath(new URL("run-state.mjs", import.meta.url)), home = os.homedir();
  const me = `node ${script.startsWith(home + path.sep) ? `~/${q(path.relative(home, script))}` : q(script)}`, method = config.merge_method || "merge";
  const migrations = failed.some((f) => f.name === "no_migrations_unless_approved");
  comment = attentionItem({ id: ctx.id, stage: "merge-decision", headline: `Merge decision: needs-human, ${failed.length} of ${decision.facts.length} facts don't hold`,
    happened: `The merge decision at \`${short(decision.head)}\` is needs-human, in ${decision.mode} mode, because these facts don't hold:\n${failed.map((f) => `- \`${f.name}\`: ${f.detail}`).join("\n")}`,
    evidence: [...new Set([`${history}/decision.json`, ...failed.flatMap((f) => f.evidence.map(inHistory))])],
    recommendation: `Read what each fact read, then ${pr ? `merge PR #${pr.number} yourself, fix it on its branch yourself, or close it` : "decide whether the branch should become a PR"}.`,
    options: [...(pr ? [[`gh api -X PUT repos/${pr.repo}/pulls/${pr.number}/merge -f sha=${decision.head} -f merge_method=${method}`, `merges PR #${pr.number} yourself, at the head the factory evaluated`]] : []),
      [`/factory resume ${ctx.id}`, `evaluates the PR again, once what failed is settled without a new commit on its branch${migrations ? `: a maintenance run's migrations approved with \`${me} approve migrations --run ${ctx.id}\`, say` : ", such as the PR's target"}`],
      ...(pr ? [[`gh api -X PATCH repos/${pr.repo}/pulls/${pr.number} -f state=closed`, `closes PR #${pr.number} unmerged`]] : [])] });
  fs.writeFileSync(path.join(dir, "attention-merge.md"), comment);
} else if (["needs-human", "failed"].includes(s.stage)) {
  const newest = fs.readdirSync(dir).filter((f) => /^attention-.+\.md$/.test(f)).sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs)[0];
  if (newest) comment = read(newest);
}
if (comment) fs.writeFileSync(commentFile, comment); else fs.rmSync(commentFile, { force: true });
console.log(`pr.md: ${path.join(dir, "pr.md")} (${md.length} characters)\n${comment ? `comment.md: ${commentFile}` : "no comment: no decision yet, and the run goes on"}`);
