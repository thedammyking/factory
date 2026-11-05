#!/usr/bin/env node
// pr-render.mjs [--merged <sha>] — renders the run's PR from its files, for no tokens (design fix 10). Takes --run <id>, or
// derives the run from the run worktree it runs in.
//   pr.md        the title and body: the spec's title, after the request issue's key as the branch has it (ENG-123:
//                <title>, #12: <title>), and goal (a oneshot's acceptance check and triage's rationale),
//                each criterion's full text with qa's result (a oneshot's one criterion its acceptance check), the
//                evidence table, Needs a decision (a person's open questions and open P0s, and the facts a needs-human decision failed), the factory's calls (grill.md's defaults), the
//                findings, the security capabilities, each implementer's assumptions and assessment verbatim, up to six
//                captures, the pinned tests qa superseded or repaired, the spec's Anti-goals, the Spec line (the Notion
//                page in its frontmatter, else where the snapshot puts it, or a oneshot's triage.md), the request
//                issue's closing reference (Closes #12, Fixes ENG-123) for the tracker's own GitHub link, and Verify in 2
//                minutes: each app's preview that preview.json has ready at the head, the local commands, then a step
//                per criterion opening its route, a bare path and never the path half of a URL (design fix 26). Above
//                the evidence table, an "Unverified on <platform>" line for each platform the run didn't verify its
//                mobile app on whose native code the diff changes.
//                After the Spec line, the Recipe line once redetect.json says what re-detecting the recipe added and left out.
//   comment.md   the decision comment, when there is one: "Merged at <sha>" with --merged or once decision.json records
//                the factory's merge, "Would merge (trial)" for a
//                merge decision, the attention item for a needs-human one (written as attention-merge.md too), and the
//                newest attention item of a run stopped needs-human or failed with no decision. Removed when there's
//                nothing to say.
// Run files are named as the snapshot will keep them, under .factory/history/<run>/, so a comment shows no local path.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, arg, git, runContext, runDiff, shellQuote as q, attentionItem, PLATFORM_NAMES, unverifiedNative } from "./lib.mjs";

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
// A oneshot has no spec: its one criterion is triage's acceptance check, which qa walks as `acceptance` (#24), and it
// titles the PR, whose Goal is triage's rationale.
// ponytail: merge-decision's triage.md parse, copied; share it from lib once the parallel edits have landed.
const triage = (() => { try { return JSON.parse([...read("triage.md").matchAll(/```json\s*\n([\s\S]*?)\n```/g)].at(-1)[1]); } catch { return {}; } })();
const oneshot = s.route === "oneshot";
const criteria = oneshot ? [{ id: "acceptance", text: String(triage.acceptance_check ?? "").replace(/\s+/g, " ").trim() }]
  : [...body.matchAll(/^- \*\*(SC-\d{3})\*\*(?: \([^)]*\))?:[ \t]*(.+)$/gm)].map(([, id, text]) => ({ id, text: text.trim() }));
const named = (oneshot ? criteria[0].text : body.match(/^# (.+)$/m)?.[1].trim()) || ctx.id, key = s.request_issue?.key;
const title = key && !named.includes(key) ? `${key}: ${named}` : named;  // a key the spec already wrote isn't added twice
const goal = oneshot ? read("triage.md").split(/^```json/m)[0].trim() : section("Goal");
const tickets = fs.existsSync(path.join(dir, "tickets")) ? fs.readdirSync(path.join(dir, "tickets")).filter((f) => /^\d{2}-.+\.md$/.test(f)).sort().map((f) => f.slice(0, -3)) : [];
const walks = tickets.map((t) => json(`tickets/${t.slice(0, 2)}/qa.json`)).filter(Boolean);
const result = (id) => [...new Set(walks.flatMap((w) => w.criteria || []).filter((c) => c.id === id).map((c) => c.reason ? `${c.status} (${c.reason})` : c.status))].join(" / ") || "not walked";
const ev = json("evidence.json") || {}, findings = json("findings.json")?.findings || [], security = json("security.json"), pr = json("pr.json");
const decision = json("decision.json"), failed = decision?.facts.filter((f) => !f.ok) ?? [];
const finding = (f) => `- ${f.id} (${f.severity} ${f.action}) \`${f.location}\`: ${f.claim}`;
const asks = findings.filter((f) => f.status === "open" && ((f.action === "ask" && f.lens?.includes("human")) || f.severity === "P0"));
// The calls the factory made in the human's place once the grill was over (#81): grill.md's answers marked (default),
// (the factory's call) or (from the map), which the human reviews here.
const calls = read("grill.md").split("\n").filter((l) => /^- Q: .*→ A: .*\((default|the factory's call|from the map)\)\s*$/.test(l));

// A criterion's route: its first bare path once every URL (a scheme's, or protocol-relative) is taken out.
const route = (text) => text.replace(/(?:[a-z][a-z\d+.-]*:)?\/\/[^\s`'")]*/gi, " ").match(/(?:^|[\s`'"(])(\/[^\s`'"),;]*)/)?.[1];
const port = (t) => String(t ?? "").replace(/\{port:[^}]+\}/g, "<port>");
// Each app's preview that preview.mjs found ready at the head; one of an earlier head isn't this PR's.
const head = git(ctx.worktree, "rev-parse", "HEAD");
const previews = Object.entries(json("preview.json")?.apps || {}).filter(([, a]) => a.status === "ready" && a.sha === head && a.url);
const reports = [...tickets.map((t) => [`Ticket ${t}`, `tickets/${t.slice(0, 2)}/implementation.md`]), ["Review fix", "review-fix.md"], ["CI fix", "ci-fix.md"]]
  .map(([name, f]) => [name, read(f)]).filter(([, text]) => text).map(([name, text]) => {
    const last = (re) => [...text.matchAll(re)].at(-1)?.[0].trimEnd() ?? "";
    return `### ${name}\n\n\`\`\`text\n${[last(/^assumptions:[ \t]*\n(?:- .*(?:\n|$))+/gm), last(/^assessment:[ \t]*\n(?:[ \t]+\S.*(?:\n|$))+/gm)].filter(Boolean).join("\n") || "no assumptions or assessment"}\n\`\`\``;
  });
const rulings = walks.flatMap((w) => [
  ...(w.superseded || []).map((t) => `- \`${t.test}\`: superseded (was ${t.was}, now ${t.now}): ${t.why}`),
  ...(w.repaired || []).map((t) => `- \`${t.test}\`: repaired (${t.change}): ${t.why}`),
]);
const notion = fm.match(/^notion:[ \t]*(\S+)/m)?.[1];
// The Recipe line, once a ticket's app manifests re-detected the recipe on the run branch (#78): what it added, and each
// command left out of it for failing its proof.
const redetect = json("redetect.json"), leftOut = Object.entries(redetect?.left_out || {});
const recipeLine = !redetect ? "" : `\n\nRecipe: re-detected on this branch${redetect.added.length ? `, adding ${redetect.added.map((a) => `\`${a}\``).join(", ")}` : ""}.`
  + (leftOut.length ? ` Left out, each having failed its proof:\n${leftOut.map(([k, c]) => `- \`${k}\`: \`${c}\``).join("\n")}` : "");
// One platform per run (#17): each platform the evidence didn't verify on whose native code the diff changes.
const verifiedOn = ev.platform ? `the run verified on ${PLATFORM_NAMES[ev.platform]}` : "the run had no device";
const unverified = !(recipe.apps || []).some((a) => a.type === "mobile") ? "" : unverifiedNative(recipe, ev.platform ?? null, runDiff(ctx).files)
  .map((u) => `Unverified on ${PLATFORM_NAMES[u.platform]}: ${verifiedOn}, and the diff changes ${u.files.map((f) => `\`${f}\``).join(", ")}.\n\n`).join("");

const md = `# ${title}

${goal}

Run \`${ctx.id}\`: \`${s.branch}\` into \`${s.target_branch}\`.

## Success criteria
| Criterion | Text | Status |
|---|---|---|
${criteria.map((c) => `| ${c.id} | ${cell(c.text)} | ${cell(result(c.id))} |`).join("\n")}

## Evidence
${ev.sha ? `At \`${short(ev.sha)}\`: green ${ev.green}, dirty ${ev.dirty}, trusted ${ev.trusted}.` : "No evidence.json."}

${unverified}| Check | Result | Duration | SHA |
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

## The factory's calls
${list(calls)}

## Assumptions and assessment
${reports.join("\n\n") || "No implementer report."}

## Captures
${list((json("captures/states.json")?.captures || []).filter((c) => c.file).slice(0, 6).map((c) => `- \`${history}/${c.file}\``))}

## Pinned tests changed
${list(rulings)}

## Anti-goals
${section("Anti-goals") || "- none in the spec"}

Spec: ${notion ?? `\`${history}/${oneshot ? "triage" : "spec"}.md\``}${recipeLine}
${s.request_issue?.closing ? `\n${s.request_issue.closing}\n` : ""}
## Verify in 2 minutes
${previews.length ? `On the preview of \`${short(head)}\`:\n${previews.map(([n, a]) => `- ${n}: ${a.url}`).join("\n")}\n\n` : ""}Locally:

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
if (merged || decision?.merged) comment = `**Merged at \`${merged ?? decision.merged}\`.** Every fact held at \`${short(decision?.head)}\`: \`${history}/decision.json\`.\n`;
else if (decision?.decision === "merge") comment = `**Would merge (trial).** Every fact holds at \`${short(decision.head)}\`: the ${decision.facts.length} are in \`${history}/decision.json\`. `
  + "In trial the factory merges nothing, so merging it as it is yourself counts toward `auto`."
  + `${decision.paused ? ` Auto acts as trial: ${decision.paused}.` : ""}\n`;
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
