# PR and the merge decision

`references/review.md` sends you here when synthesis says `ship`: the run has reached the PR stage. Scripts render the PR, open it and decide it, for no tokens. You write no word of the PR, and the decision is `merge-decision.mjs`'s, computed from facts, never yours. The scripts sit beside `run-state.mjs`. Call each as `node <that directory>/<script> --run <id>`, written out in full, and print what it prints.

1. **Render.** `pr-render.mjs` writes `pr.md`.
2. **Open.** `pr-open.mjs` pushes the run branch and opens the PR ready, labelled `factory`. On a hotfix lane it also opens the back-merge PR into `develop`.
   Then **Preview**: `preview.mjs` writes `preview.json`, where each touched app's preview of the head is, waiting up to 10 minutes on the host. Run it with Bash's `run_in_background`, say `Reading <id>'s previews.` and end your turn. When it wakes you, print the background task's output and go on, whatever it says or exits: a preview never stops the run. Then read `references/ci.md` beside this file and follow it: it comes back to step 3 once CI is green at the head.
3. **Decide.** `merge-decision.mjs` writes `decision.json` and prints `DECISION merge` or `DECISION needs-human`, with each fact that doesn't hold. In `auto` it merges a `merge` decision itself, at the head it evaluated, and prints `MERGED <sha>`; a merge GitHub refuses makes the decision needs-human. While a factory revert PR is open, `auto` acts as `trial`, and it says so. When all it prints is `CATCH-UP …`, it made no decision yet: go to the **Catch-up** (below).
4. **Render** again. `pr-render.mjs` adds the decision to `pr.md` and writes the decision comment, `comment.md`: "Would merge (trial)", "Merged at `<sha>`", or the attention item, which it also writes as `attention-merge.md`.
5. **Record.** `pr-open.mjs` again updates the body, adds the decision's label and posts the comment, once.
6. **End.** When step 3 printed `MERGED <sha>`, read `references/watch.md` beside this file and follow it instead: the watch after the factory's own merge ends the run. Otherwise, on `DECISION merge`, run `run-state set stage delivered --run <id>`; otherwise `run-state set stage needs-human --run <id>`. Then the snapshot (see **Ending a run** in the skill). Print the PR's URL, and on needs-human `attention-merge.md` too, then stop. Never merge a PR yourself, and never change `merge` in `.factory/config.json`: only the human switches the mode.

Only the human approves a maintenance run's migrations, which the merge decision reads. Never run `run-state approve migrations` on your own: only when the human tells you in this session to approve this run's migrations.

To stop when a step exits non-zero, write `attention-pr.md`. Its headline names the step; What happened quotes its output; Evidence lists `pr.md`, `pr.json` and `decision.json`, those that exist; the options are `/factory resume <id>` (the PR stage again, from step 1) and `/factory abandon <id>`. Run `run-state set stage needs-human --run <id>` and the snapshot, print it and stop.

## Catch-up

In `auto`, a run behind its base and nothing else gets one catch-up, and `merge-decision.mjs` never asks twice. Run `sync-base.mjs before-merge`: it merges the base into the PR on GitHub (update-branch) and takes that merge. On exit 1 it wrote `attention-sync.md` and ended the run needs-human: run `pr-render.mjs` and `pr-open.mjs`, then the snapshot; print that item and stop. Otherwise run `verify.mjs --full` with Bash's `run_in_background`, say `Verifying <id> on its base.` and end your turn. When it wakes you, whatever it exits, run `classify-diff.mjs` and `security-scan.mjs` (exit 1 is a capability the decision reads: go on), then go to step 1: the PR's preview and CI are read at the new head, and step 3 decides once more. Until then the PR gets no decision label or comment.

## Draft

`references/review.md` sends you here when the review stops, once its attention item is written and the run's stage is set to needs-human, before the snapshot. Run `pr-render.mjs`, then `pr-open.mjs`: it opens the PR as a draft, labelled `needs-human`, whose first comment is that attention item. If either exits non-zero, print its output beside the attention item: the stop stands. Then go on to the snapshot.
