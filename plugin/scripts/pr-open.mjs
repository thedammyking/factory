#!/usr/bin/env node
// pr-open.mjs — opens the run's PR from pr.md, or updates the one pr.json records (the only sign of an open PR), through
// GitHub's REST API alone: `gh api`, never `gh pr`, which is GraphQL. Takes --run <id>, or derives the run from the run
// worktree it runs in. It pushes the run branch to origin first, unless decision.json says it merged the PR, then:
//   - opens the PR ready when the run reached the PR stage, so REST can merge it, and as a draft only for a stopped run
//     (needs-human or failed), whose PR just carries the attention item: REST can't take a PR out of draft;
//   - on a hotfix lane (git flow, targeting main) at the PR stage, opens the back-merge PR into develop beside it, once,
//     labelled factory and needs-human, since both are always a human's;
//   - labels it factory, plus factory-merge on a merge decision or needs-human on a needs-human one or a stopped run,
//     taking the other off;
//   - posts comment.md, pr-render's decision comment, once, marked <!-- factory --> so the factory's comments are known.
// Each PR body ends in the session's attribution lines (lib's attributed).
// pr.json holds repo, number, url, head, base, draft, labels, the hash of each comment posted and back_merge. Prints a
// line per thing done. Exits 1 when the push or a call fails, quoting git or GitHub, and 2 when it can't start.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJson, git, gitError, runContext, githubRepo, ghApi, attributed } from "./lib.mjs";

const die = (msg, code = 2) => { console.error(`pr-open: ${msg}`); process.exit(code); };
const ctx = runContext(), s = readJson(ctx.state), dir = ctx.runDir, file = path.join(dir, "pr.json");
const config = readJson(path.join(ctx.MAIN, ".factory", "config.json"), {}), decision = readJson(path.join(dir, "decision.json"));
const read = (f) => { try { return fs.readFileSync(path.join(dir, f), "utf8"); } catch { return ""; } };
const repo = githubRepo(ctx.MAIN);
if (!repo) die("origin isn't a GitHub repo, and the PR is opened on GitHub");
const md = read("pr.md");
if (!md) die("no pr.md: run pr-render.mjs first");
const title = md.split("\n")[0].replace(/^# /, ""), body = attributed(md.slice(md.indexOf("\n") + 1).trim(), "pr", s);
// ponytail: the body and the comment each travel as one argument, which past Linux's 128 KiB, or GitHub's 65,536
// characters, fails with the reason quoted; send them with --input if PR bodies ever grow that long.
const gh = (...a) => { const r = ghApi(...a); if (!r.ok) die(`GitHub refused ${a[1]} ${a[2]}: ${r.message}`, 1); return r.json; };
let pr = readJson(file);
const save = () => fs.writeFileSync(file, JSON.stringify(pr, null, 2) + "\n");
const label = (n, names) => gh("-X", "POST", `repos/${repo}/issues/${n}/labels`, ...names.flatMap((l) => ["-f", `labels[]=${l}`]));

// A PR the factory merged is never pushed to again: GitHub may have deleted its branch on merge.
if (!decision?.merged) try { git(ctx.worktree, "push", "-q", "origin", `HEAD:refs/heads/${s.branch}`); } catch (e) { die(`can't push ${s.branch} to origin: ${gitError(e)}`, 1); }
const stopped = ["needs-human", "failed"].includes(s.stage);  // not suspended, which resume carries on to the PR stage
if (!pr) {
  const made = gh("-X", "POST", `repos/${repo}/pulls`, "-f", `title=${title}`, "-f", `head=${s.branch}`, "-f", `base=${s.target_branch}`, "-F", `draft=${stopped}`, "-f", `body=${body}`);
  pr = { repo, number: made.number, url: made.html_url, head: s.branch, base: s.target_branch, draft: stopped, labels: [], comments: [] };
  save();
  console.log(`PR #${pr.number} opened${stopped ? " as a draft" : ""}: ${pr.url}`);
} else {
  gh("-X", "PATCH", `repos/${repo}/pulls/${pr.number}`, "-f", `title=${title}`, "-f", `body=${body}`);
  console.log(`PR #${pr.number} updated: ${pr.url}`);
}

const branching = config.branching || {}, develop = branching.develop || "develop";
if (!stopped && !pr.back_merge && branching.model === "git-flow" && s.target_branch === (branching.main || "main")) {
  const made = gh("-X", "POST", `repos/${repo}/pulls`, "-f", `title=Back-merge ${s.branch} into ${develop}`, "-f", `head=${s.branch}`, "-f", `base=${develop}`, "-F", "draft=false",
    "-f", `body=${attributed(`The back-merge of the hotfix in #${pr.number}, so \`${develop}\` keeps it. It has no review loop of its own: the hotfix's is #${pr.number}'s, and a conflict is a human's to resolve.`, "pr", s)}`);
  label(made.number, ["factory", "needs-human"]);
  pr.back_merge = { number: made.number, url: made.html_url };
  save();
  console.log(`back-merge PR #${made.number} opened into ${develop}: ${made.html_url}`);
}

const verdict = decision ? (decision.decision === "merge" ? "factory-merge" : "needs-human") : stopped ? "needs-human" : null;
const add = ["factory", ...(verdict ? [verdict] : [])].filter((l) => !pr.labels.includes(l));
if (add.length) { label(pr.number, add); pr.labels.push(...add); save(); console.log(`labelled ${add.join(", ")}`); }
const opposite = { "factory-merge": "needs-human", "needs-human": "factory-merge" }[verdict];
if (opposite && pr.labels.includes(opposite)) {
  gh("-X", "DELETE", `repos/${repo}/issues/${pr.number}/labels/${opposite}`);
  pr.labels = pr.labels.filter((l) => l !== opposite); save();
  console.log(`unlabelled ${opposite}`);
}
const comment = read("comment.md").trimEnd(), hash = crypto.createHash("sha256").update(comment).digest("hex").slice(0, 16);
if (comment && !pr.comments.includes(hash)) {
  gh("-X", "POST", `repos/${repo}/issues/${pr.number}/comments`, "-f", `body=${comment}\n\n<!-- factory -->`);
  pr.comments.push(hash); save();
  console.log(`commented: ${comment.split("\n")[0]}`);
}
