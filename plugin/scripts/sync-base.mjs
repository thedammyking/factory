#!/usr/bin/env node
// sync-base.mjs before-review | before-merge — brings the run branch up to lib's live base of the run, in the run
// worktree. Takes --run <id>, or derives the run from the run worktree it runs in.
//   before-review  before the review package, while no PR is open: rebases the run's own commits (base_sha..HEAD) onto
//                  the base, so review sees the tree that will merge. Every SHA changes, so verify --full runs again.
//   before-merge   once evidence is pinned, never a rebase: with pr.json (the only sign of an open PR, never `gh pr view`),
//                  PUT /pulls/{n}/update-branch merges the base in on GitHub and the branch fast-forwards to that merge;
//                  without it, a local merge.
// base_sha then becomes the base's tip, through run-state. Prints `rebased …`, `merged …` or `up-to-date …`. A conflict,
// GitHub's refusal or a merge that never arrives leaves the branch as it was: the rebase or merge is aborted,
// attention-sync.md says why, the run ends needs-human, and it prints `needs-human: <attention item>` and exits 1 (design
// fix 22).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readJson, git, gitError, runContext, liveBase, pause, ghApi, shellQuote as q, attentionItem } from "./lib.mjs";

const mode = process.argv[2];
const die = (msg) => { console.error(`sync-base: ${msg}`); process.exit(2); };
if (!["before-review", "before-merge"].includes(mode)) die("usage: sync-base.mjs before-review | before-merge --run <id>");
const ctx = runContext(), s = readJson(ctx.state), wt = ctx.worktree, pr = readJson(path.join(ctx.runDir, "pr.json"));
const RUN_STATE = fileURLToPath(new URL("run-state.mjs", import.meta.url));
const runState = (...a) => spawnSync(process.execPath, [RUN_STATE, ...a, "--run", ctx.id], { encoding: "utf8" });
const contains = (rev, commit) => { try { git(wt, "merge-base", "--is-ancestor", commit, rev); return true; } catch { return false; } };

// Writes attention-sync.md and ends the run needs-human.
function stop(headline, happened, yourself) {
  const file = path.join(ctx.runDir, "attention-sync.md");
  fs.writeFileSync(file, attentionItem({ id: ctx.id, stage: `sync-base ${mode}`, headline, happened, evidence: [ctx.state],
    recommendation: "Bring the branch up to its base by hand, keeping both sides' intent.",
    options: [yourself, [`/factory abandon ${ctx.id}`, "ends the run abandoned; its branch is kept"]] }));
  const r = runState("set", "stage", "needs-human");
  if (r.status) die(`run-state set stage needs-human failed: ${r.stderr}`);
  console.log(`needs-human: ${file}`);
  process.exit(1);
}
// After a failed rebase or merge: its conflicted files, once it's aborted. A failure with none isn't a conflict.
function aborted(cmd, e) {
  const list = git(wt, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
  try { git(wt, cmd, "--abort"); } catch {}
  if (!list.length) die(`the ${cmd} failed: ${gitError(e)}`);
  return list.map((f) => `\`${f}\``).join(", ");
}

if (mode === "before-review" && pr) die(`PR #${pr.number} is open, so its branch is never rebased: sync-base.mjs before-merge`);
let base; try { base = liveBase(wt, s.base_branch); } catch (e) { die(`can't fetch ${s.base_branch} from origin: ${gitError(e)}`); }
const tip = git(wt, "rev-parse", base), head = git(wt, "rev-parse", "HEAD"), at = `\`${s.base_branch}\` at \`${tip.slice(0, 7)}\``;
const mergeYourself = [`git -C ${q(wt)} merge ${q(base)}`, "merges the base in yourself, stopping at the conflicts"];
let done = `up-to-date with ${base} at ${tip.slice(0, 7)}`;
// A rebase is current only when the run's commits sit on the tip: a local base origin is behind would carry its own.
if (mode === "before-review" ? s.base_sha !== tip : !contains(head, tip)) {
  if (mode === "before-review") {
    try { git(wt, "rebase", "-q", "--onto", tip, s.base_sha); } catch (e) {
      stop(`Rebasing onto ${s.base_branch} conflicts`, `Rebasing the run's commits onto ${at} conflicts in ${aborted("rebase", e)}, so the rebase was aborted and the branch is as it was.`,
        [`git -C ${q(wt)} rebase --onto ${tip} ${s.base_sha}`, "replays the run's commits on the base yourself, stopping at each conflict"]);
    }
    done = `rebased onto ${base} at ${tip.slice(0, 7)}: every SHA changed, so run verify --full again`;
  } else if (pr) {
    // A 202 is asynchronous: GitHub merges the base into the PR's branch, and the merge arrives there a little later.
    const r = ghApi("-X", "PUT", `repos/${pr.repo}/pulls/${pr.number}/update-branch`, "-f", `expected_head_sha=${head}`);
    if (!r.ok) stop(`GitHub refused to update PR #${pr.number} from ${s.base_branch}`, `GitHub refused to merge ${at} into PR #${pr.number}: "${r.message}". The branch is as it was.`, mergeYourself);
    // ponytail: a blocking poll, 20 fetches 3 s apart; a merge GitHub takes longer than a minute over stops the run.
    const remote = `refs/remotes/origin/${pr.head}`;
    for (let n = 0; n < 20 && !contains("HEAD", tip); n++) {
      if (n) pause(3000);
      try { git(wt, "fetch", "-q", "origin", `+refs/heads/${pr.head}:${remote}`); if (contains(remote, head) && contains(remote, tip)) git(wt, "merge", "-q", "--ff-only", remote); } catch {}
    }
    if (!contains("HEAD", tip)) stop(`GitHub's update of PR #${pr.number} didn't arrive`, `GitHub accepted merging ${at} into PR #${pr.number}, but no merge reached \`${pr.head}\` `
      + "on origin as a fast-forward within a minute. The local branch is as it was, and GitHub's merge may still land on origin.",
      [`git -C ${q(wt)} pull --ff-only origin ${q(pr.head)}`, "takes GitHub's merge once it has landed"]);
    done = `merged ${base} at ${tip.slice(0, 7)} through update-branch on PR #${pr.number}: run verify --full again`;
  } else {
    try { git(wt, "merge", "-q", "--no-edit", base); } catch (e) {
      stop(`Merging ${s.base_branch} in conflicts`, `Merging ${at} into the run branch conflicts in ${aborted("merge", e)}, so the merge was aborted and the branch is as it was.`, mergeYourself);
    }
    done = `merged ${base} at ${tip.slice(0, 7)}: run verify --full again`;
  }
}
if (s.base_sha !== tip) {
  const r = runState("set", "base_sha", JSON.stringify(tip));
  if (r.status) die(`run-state set base_sha failed: ${r.stderr}`);
}
console.log(done);
