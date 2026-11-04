#!/usr/bin/env node
// pr-comments.mjs — the human lens: writes review-human.md, in the lenses' finding schema, from the review threads and
// reviews on the run's PR (pr.json) as GitHub holds them now, for synthesize to read beside the other lenses. Takes
// --run <id>, or derives the run from the run worktree it runs in. The file is written whole each time: GitHub's state is
// the source of truth, so a thread resolved there is resolved here, and one unresolved there is open again.
//   - Ids are human-r<the thread's root comment> and human-v<the review>, so a resolution never moves to another finding
//     (design fix 18).
//   - A post carrying the <!-- factory --> marker is the factory's, whoever wrote it: a solo developer and the factory
//     share one login. A thread it started is no finding, and its replies are no part of one.
//   - Only an OWNER, MEMBER or COLLABORATOR acts: a change request is a P1 fix, and one whose newest words end in a
//     question mark a P1 ask. Anyone else's thread or review is a P3 note that shows its author, and their replies are
//     left out of a trusted thread.
//   - A CHANGES_REQUESTED review with a body is a finding, resolved by a later approval from its reviewer or a dismissal
//     (design fix 19). Once pr-resolve has answered it (a marked PR comment naming it), it's an ask: only its reviewer
//     closes it. Other reviews, and a request with no body, whose threads carry it, are none.
// A thread's resolved state is only in GraphQL, so this read and pr-resolve's resolve are the factory's only GraphQL
// calls (`gh api graphql`), which a local session reaches and a cloud session doesn't.
// Prints the open count, each open finding, then the file. Exits 1 when GitHub refuses, quoting it, writing nothing.
import fs from "node:fs";
import path from "node:path";
import { readJson, runContext, githubRepo, ghApi } from "./lib.mjs";

const die = (msg, code = 2) => { console.error(`pr-comments: ${msg}`); process.exit(code); };
const ctx = runContext(), pr = readJson(path.join(ctx.runDir, "pr.json"));
if (!pr) die("no pr.json: the run has no PR");
const repo = githubRepo(ctx.MAIN);
if (!repo) die("origin isn't a GitHub repo");
const [owner, name] = repo.split("/");
// ponytail: the first 100 threads, comments per thread and reviews; page through them if a factory PR ever has more.
const QUERY = "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { "
  + "reviewThreads(first: 100) { nodes { id isResolved path line originalLine comments(first: 100) { nodes { databaseId body url authorAssociation author { login } } } } } "
  + "reviews(first: 100) { nodes { databaseId state body url authorAssociation author { login } } } comments(last: 100) { nodes { body } } } } }";
const r = ghApi("graphql", "-f", `query=${QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${pr.number}`);
const got = r.json?.data?.repository?.pullRequest;
if (!r.ok || r.json?.errors || !got) die(`GitHub refused the review threads of #${pr.number}: ${r.message || "no pull request in its answer"}`, 1);

const FACTORY = /<!--\s*factory\s*-->/, TRUSTED = ["OWNER", "MEMBER", "COLLABORATOR"];
const login = (c) => c.author?.login ?? "ghost";
const said = (c) => `@${login(c)}${TRUSTED.includes(c.authorAssociation) ? "" : ` (${c.authorAssociation}, not a collaborator)`}: ${c.body.replace(/\s+/g, " ").trim()}`;
// words: the posts that make the claim, the first one's author deciding whether it acts
// ponytail: a question is words ending in "?", so "Can you rename this?" stops the run as an ask; read the intent with a
// model if that ever stops runs the human meant to go on.
const item = (id, words, location, resolved, thread, answered = false) => {
  const trusted = TRUSTED.includes(words[0].authorAssociation), ask = answered || /\?$/.test(words.at(-1).body.trim());
  return { id, severity: trusted ? "P1" : "P3", action: trusted ? (ask ? "ask" : "fix") : "note", location, claim: words.map(said).join(" | "),
    evidence: words[0].url, resolved, thread, answered };
};
const items = [];
for (const t of got.reviewThreads.nodes) {
  const [root, ...replies] = t.comments.nodes;
  if (!root || FACTORY.test(root.body)) continue;
  const words = TRUSTED.includes(root.authorAssociation) ? [root, ...replies.filter((c) => !FACTORY.test(c.body) && TRUSTED.includes(c.authorAssociation))] : [root];
  items.push(item(`human-r${root.databaseId}`, words, `${t.path}:${t.line ?? t.originalLine ?? 0}`, t.isResolved, t.id));
}
const reviews = got.reviews.nodes;
reviews.forEach((v, i) => {
  if (!["CHANGES_REQUESTED", "DISMISSED"].includes(v.state) || !v.body.trim() || FACTORY.test(v.body)) return;
  const approved = reviews.slice(i + 1).some((w) => w.state === "APPROVED" && login(w) === login(v));
  const answered = got.comments.nodes.some((c) => FACTORY.test(c.body) && c.body.includes(v.url));
  items.push(item(`human-v${v.databaseId}`, [v], "", v.state === "DISMISSED" || approved, null, answered));
});

const FIX = { fix: "Make the change the comment asks for.", ask: "Answer it on the PR: the human resolves it.", note: "Nothing: not a collaborator's." };
const open = items.filter((i) => !i.resolved);
const blocks = items.map((i) => [`- id: ${i.id}`, `  severity: ${i.severity}`, `  action: ${i.action}`, `  location: ${i.location}`, `  claim: ${i.claim}`,
  `  evidence: ${i.evidence}`, `  fix: ${i.answered ? "The factory answered it: its reviewer approves it or dismisses it." : FIX[i.action]}`, ...(i.thread ? [`  thread: ${i.thread}`] : []),
  ...(i.resolved ? [`- id: ${i.id}`, "  status: closed", "  note: resolved on GitHub"] : [])].join("\n"));
const file = path.join(ctx.runDir, "review-human.md");
fs.writeFileSync(file, `# Human review\n\nPR #${pr.number}'s review threads and reviews, as GitHub holds them.\n\n${blocks.join("\n") || "No findings."}\n\n`
  + `verdict: ${open.some((i) => i.severity === "P1") ? "needs-fixes" : "approve"}\n`);
console.log(`pr-comments: PR #${pr.number}, ${open.length} open of ${items.length}`);
for (const i of open) console.log(`  ${i.severity} ${i.action} ${i.id} ${i.location || `PR #${pr.number}`}`);
console.log(`review-human.md: ${file}`);
