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
// The PR pr.json records, as GitHub has it now (#81): one a human merged before the run's last commits leaves those
// commits a PR of their own, and one closed unmerged is the human's to reopen. pr.json may still say draft of either.
let after = "";
if (pr && !decision?.merged) {
  const now = ghApi(`repos/${repo}/pulls/${pr.number}`);
  if (now.ok && now.json.merged_at) {
    let carried = false; try { git(ctx.worktree, "merge-base", "--is-ancestor", "HEAD", now.json.head.sha); carried = true; } catch {}
    if (carried) { console.log(`PR #${pr.number} merged already, with everything on ${s.branch}: nothing to open`); process.exit(0); }
    console.log(`PR #${pr.number} was merged before the run's last commits, so they get a PR of their own`);
    after = `#${pr.number} merged before these commits of the run, so this PR carries them.\n\n`;
    pr = null;
  } else if (now.ok && now.json.state === "closed") die(`PR #${pr.number} was closed unmerged: reopening it is the human's call`, 1);
}

// A PR the factory merged is never pushed to again: GitHub may have deleted its branch on merge. Before the run's PR
// exists, the branch on origin is only the base its ticket PRs merged into (#81), which the review's rebase rewrote, so it
// is replaced, with a lease on the copy last pushed (a branch never pushed must not exist there, so nobody else's is
// overwritten); after, never forced.
const seen = (() => { try { return git(ctx.worktree, "rev-parse", "--verify", "-q", `refs/remotes/origin/${s.branch}`); } catch { return ""; } })();
const force = pr ? [] : [`--force-with-lease=refs/heads/${s.branch}:${seen}`];
if (!decision?.merged) try { git(ctx.worktree, "push", "-q", ...force, "origin", `HEAD:refs/heads/${s.branch}`); } catch (e) { die(`can't push ${s.branch} to origin: ${gitError(e)}`, 1); }
const stopped = ["needs-human", "failed"].includes(s.stage);  // not suspended, which resume carries on to the PR stage
if (!pr) {
  const made = gh("-X", "POST", `repos/${repo}/pulls`, "-f", `title=${title}`, "-f", `head=${s.branch}`, "-f", `base=${s.target_branch}`, "-F", `draft=${stopped}`, "-f", `body=${after}${body}`);
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
