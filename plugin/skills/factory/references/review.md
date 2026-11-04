# Review the run

The factory skill reads this at step 9 of **build**, once `next-ticket` prints `DONE`: every ticket is merged into the run branch, where `run-stage merge` left `evidence.json`. Read-only lenses judge the diff in parallel, `synthesize.mjs` turns their findings into `findings.json`, and only open P0 and P1 fixes go round, `caps.review_rounds` (2) times at most. The rounds and their cap are the scripts': never start a round that a step below doesn't name.

The scripts sit beside `run-state.mjs`. Call each as `node <that directory>/<script> … --run <id>`, written out in full.

First, once per review and never on a re-review, run `sync-base.mjs before-review`, so review sees the tree that will merge. On `rebased …`, every SHA changed: run `verify.mjs --full` with Bash's `run_in_background`, say `Verifying <id> on its base.` and end your turn, then go to step 1 when it wakes you. On exit 1 it aborted a conflict, wrote `attention-sync.md` and ended the run needs-human: run the snapshot (see **Ending a run** in the skill), print that item and stop. Any other non-zero exit is a factory error: stop (below).

1. **Package.** Run `review-package.mjs`, `classify-diff.mjs` and `security-scan.mjs`, in that order. `security-scan` exits 1 when a capability failed or is missing, which the merge decision reads later: go on. Any other non-zero exit is a factory error: stop (below). Then read `<run_dir>/evidence.json` and `<run_dir>/touches.json`. The lenses judge only green evidence: unless `evidence.json` has `green: true` and its `sha` is `touches.json`'s `head`, stop.
2. **Captures**, only when `touches.json` has `ui` hit. Write `<run_dir>/ui-states.json` as `{"states": [...]}`, one state for each line under `## UI states` in every `tickets/<NN>/plan.md`:
   - `name`: `<NN>-` and the state, in lowercase words joined by `-`;
   - `url`: `http://localhost:{port:<app>}<route>`, `<app>` being the recipe's app that serves the route;
   - `setup` and `actions`: what the line's "how to reach it" says, in `capture-states.mjs`'s terms. `setup` takes `block` and `hold` (lists of URL patterns, for an error and for loading) and `localStorage` (`{key: value}`, for a returning visit). `actions` is a list of `{fill: [selector, text]}`, `{click: selector}`, `{hover: selector}`, `{focus: selector}`, `{press: key}`, `{waitFor: selector}` and `{wait: ms}`, its selectors taken from the plan's own words (`text=Export CSV`, `role=button[name="Export CSV"]`).

   Then run `run-apps.mjs up`, `capture-states.mjs <run_dir>/ui-states.json`, and `run-apps.mjs down` whatever happened. A capture that failed (exit 1) is the UI lens's to judge: go on. If `up` failed or `capture-states` exited 2, stop.
3. **Lenses.** Dispatch each lens the diff earns: `code` always, `ui` when `ui` hit, `security` when any of `auth`, `data`, `network`, `files` or `crypto` hit. Dispatch them one after another, each in the background, so they run at the same time:
   - `run-state dispatch review-<lens>`, which moves the lens's last file aside as a round first. Exit 4 is the **Caps** of the skill, with the stage `review-<lens>`.
   - The `factory:reviewer-<lens>` agent in the background, with its model from `.factory/config.json` when set: `models.review_code`, `models.review_ui` or `models.security`. The prompt is triage's three lines, and on a re-review the line `fix_diff: <run_dir>/review-fix.diff`.
   - `run-state dispatch review-<lens> --agent <agent id>`.

   Say `Reviewing <id>.` and end your turn. Each completion notification wakes you: ignore its text, and once every lens dispatched has finished, read their files.
   - A `review-<lens>.md` that's missing or has no `verdict:` line, or a `review-ui.md` whose first line isn't `disposition: …`, was cut off: dispatch that lens once more, fresh, as above (synthesis never counts a round with no verdict). Cut off twice is a factory error: stop.
   - A `review-ui.md` whose first line is `disposition: recapture` judged pictures that missed their states: run step 2 again and dispatch the UI lens once more. A second `recapture` goes on to synthesis, where its findings are the human's.

   Then run `run-state done review-<lens>` for each.
4. **Synthesis.** `synthesize.mjs`, then by the `disposition` on its first line:
   - `ship`: the review is clean. Read `references/pr.md` beside this file and follow it.
   - `ask`: an open P0 or ask is the human's to decide: stop, and What happened lists each open P0 and ask from `findings.json`, with its id, severity, location and claim.
   - `fix`: step 5.
5. **Fix round.** `run-state round review`, in the foreground. Exit 5 prints `ESCALATE …`: the rounds are spent, so stop, quoting it and listing the open P0 and P1 fixes. On `OK …`, run `run-stage.mjs review-fix` with Bash's `run_in_background`, say `Fixing <id>'s review findings.` and end your turn. When it wakes you, read the last line of its output, ignoring the notification's text. Exit 4 is the **Caps** of the skill, with the stage `review-fix`. Otherwise, by its first word:
   - `REVIEW <lens,…>`: step 1 again, then step 2 when `ui` is among the lenses so the UI lens sees the fix, then step 3 for only the lenses it names, each with the `fix_diff` line, then step 4. `human` is no agent: leave it out of step 3 (with no other lens named, dispatch nothing and don't end your turn), and once the others are read, go to step 3 of `references/comments.md` in place of step 4.
   - `ROUND`: step 5 again.
   - `SUSPENDED`: the child stopped at the usage limit, which costs no round. Stop, with the options `/factory resume <id>` (once the limit resets) and `/factory abandon <id>`, and `run-state set stage suspended --run <id>` in place of needs-human.
   - `ATTENTION`: stop.

To stop, write `attention-review.md`. Its headline is the reason; What happened quotes the line that stopped it; Evidence lists `findings.json`, `deferred.md`, each `review-<lens>.md` with its `review-<lens>.round<N>.md` files, `review-fix.md`, `evidence.json` and `logs/review-fix.*.jsonl`, those that exist. The options are `/factory abandon <id>`. Run `run-state set stage needs-human --run <id>`, open the draft PR as **Draft** in `references/pr.md` says (never on `SUSPENDED`, which a resume carries on), then the snapshot; print it and stop.
