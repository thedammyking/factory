#!/usr/bin/env node
// pr-resolve.mjs — answers on GitHub what a review fix round fixed for the human lens. Takes --run <id>, or derives the
// run from the run worktree it runs in. The round's human findings are the human-… members of findings.json's open P0
// and P1 fixes, the ones run-stage review-fix gave the implementer, that are change requests themselves: a stranger's
// note synthesis grouped with one is never answered. It pushes the run branch, so the head's SHA is on GitHub, then
// for each thread not yet recorded, each step only once the one before it succeeded (design fix 20):
//   1. replies on the thread with the SHA, marked <!-- factory --> so pr-comments never takes it for the human's;
//   2. resolves the thread, through GraphQL's resolveReviewThread, since REST has no thread state;
//   3. records the resolution as a status: closed block in review-human.md, which synthesize reads.
// Where pr-comments read the PR over REST (`source: rest`, docs/adr/0001), it skips step 2: the thread stays open on
// GitHub, and the next ingest makes it an ask.
// A review has no thread: it gets the reply as a PR comment, and stays open until its reviewer approves it or it's
// dismissed. An ask is the human's, and gets nothing. Exits 1 at the first refusal, quoting GitHub; run again, it
// carries on from the first thread not recorded.
// ponytail: a thread whose resolve was refused after its reply posted is replied to again on the retry; read the
// thread's last comment first if that noise ever matters.
import fs from "node:fs";
import path from "node:path";
import { readJson, git, gitError, runContext, githubRepo, ghApi } from "./lib.mjs";

const die = (msg, code = 2) => { console.error(`pr-resolve: ${msg}`); process.exit(code); };
const ctx = runContext(), s = readJson(ctx.state), pr = readJson(path.join(ctx.runDir, "pr.json")), file = path.join(ctx.runDir, "review-human.md");
if (!pr) die("no pr.json: the run has no PR");
const repo = githubRepo(ctx.MAIN);  // from git's trimmed output, so no newline reaches a path (design fix 20)
if (!repo) die("origin isn't a GitHub repo");
const lens = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
const key = (id, k) => lens.match(new RegExp(`^- id: ${id}\\n(?:[ \\t]+.*\\n)*?[ \\t]+${k}:[ \\t]*(\\S+)`, "m"))?.[1];
const recorded = (id) => new RegExp(`^- id: ${id}\\n[ \\t]+status: closed$`, "m").test(lens), rest = /^source: rest$/m.test(lens);
const fixes = (readJson(path.join(ctx.runDir, "findings.json"))?.findings || []).filter((f) => f.status === "open" && ["P0", "P1"].includes(f.severity) && f.action === "fix");
const ids = [...new Set(fixes.flatMap((f) => f.members))].filter((id) => /^human-[rv]\d+$/.test(id) && key(id, "action") === "fix" && !recorded(id));
if (!ids.length) { console.log("pr-resolve: no human finding of the round to answer"); process.exit(0); }

try { git(ctx.worktree, "push", "-q", "origin", `HEAD:refs/heads/${s.branch}`); } catch (e) { die(`can't push ${s.branch} to origin: ${gitError(e)}`, 1); }
const sha = git(ctx.worktree, "rev-parse", "HEAD"), MARK = "\n\n<!-- factory -->";
const RESOLVE = "mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }";
const refused = (what, r) => die(`GitHub refused ${what}: ${r.message || "no resolved thread in its answer"}`, 1);
for (const id of ids) {
  if (id.startsWith("human-v")) {
    const r = ghApi("-X", "POST", `repos/${repo}/issues/${pr.number}/comments`, "-f", `body=Addressed in ${sha}: ${key(id, "evidence")}${MARK}`);
    if (!r.ok) refused(`the reply to ${id}`, r);
    console.log(`${id}: replied with ${sha.slice(0, 7)}; a review resolves when its reviewer approves it or it's dismissed`);
    continue;
  }
  const thread = key(id, "thread");
  if (!thread && !rest) die(`review-human.md has no thread for ${id}: run pr-comments.mjs again`);
  const reply = ghApi("-X", "POST", `repos/${repo}/pulls/${pr.number}/comments/${id.replace("human-r", "")}/replies`, "-f", `body=Addressed in ${sha}.${MARK}`);
  if (!reply.ok) refused(`the reply to ${id}`, reply);
  if (rest) {
    fs.appendFileSync(file, `- id: ${id}\n  status: closed\n  note: answered in ${sha.slice(0, 7)}; open on GitHub, since resolving it takes GraphQL\n`);
    console.log(`${id}: replied with ${sha.slice(0, 7)} and recorded; the thread stays open on GitHub, since resolving it takes GraphQL`);
    continue;
  }
  const r = ghApi("graphql", "-f", `query=${RESOLVE}`, "-f", `id=${thread}`);
  if (!r.ok || r.json?.data?.resolveReviewThread?.thread?.isResolved !== true) refused(`to resolve ${id}`, r);
  fs.appendFileSync(file, `- id: ${id}\n  status: closed\n  note: answered in ${sha.slice(0, 7)} and resolved on GitHub\n`);
  console.log(`${id}: replied with ${sha.slice(0, 7)}, resolved and recorded`);
}
