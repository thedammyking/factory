# CI on the PR

`references/pr.md` sends you here once the PR is open: CI on it decides what comes next. `ci-watch.mjs` reads it, re-running a failed workflow run once to tell a flake, and `run-stage.mjs ci-fix` fixes a red that is the run's own, `caps.ci_rounds` (1) times at most. The rounds and their cap are the scripts': never start a round that a step below doesn't name, and never re-run CI yourself.

The scripts sit beside `run-state.mjs`. Call each as `node <that directory>/<script> --run <id>`, written out in full, and print what it prints.

1. **Read.** Run `ci-watch.mjs` with Bash's `run_in_background`, since it waits for CI, up to 15 minutes, and as long again for a re-run: say `Reading CI on <id>.` and end your turn. When it wakes you, read the background task's output, ignoring the notification's text. Its last line is `CI <cause> at <sha>: <why>`:
   - `green`, or `flake` (its re-run passed): go to step 3 of `references/pr.md`, the merge decision.
   - `ours`: step 2.
   - On exit 1 the cause was `inherited` (the base fails at the same steps) or `infra` (CI reached no result), and its last line is `needs-human: <attention item>`: it wrote `attention-ci.md` and ended the run needs-human. Run `pr-render.mjs` and `pr-open.mjs`, then the snapshot, as a stop does (below).
   - Any other non-zero exit is a factory error: stop.
2. **Fix round.** `run-state round ci`, in the foreground. Exit 5 prints `ESCALATE …`: the round is spent, so stop, quoting it and `ci.json`'s failing steps. On `OK …`, run `run-stage.mjs ci-fix` with Bash's `run_in_background`, say `Fixing <id>'s CI.` and end your turn. When it wakes you, read the last line of its output, ignoring the notification's text. Exit 4 is the **Caps** of the skill, with the stage `ci-fix`. Otherwise, by its first word:
   - `PUSH`: the fix is green locally. Go to step 1 of `references/pr.md`, which renders the PR again, pushes the fix and comes back to step 1 here.
   - `ROUND`: step 2 again.
   - `SUSPENDED`: the child stopped at the usage limit, which costs no round. Stop, with the options `/factory resume <id>` (once the limit resets) and `/factory abandon <id>`, and `run-state set stage suspended --run <id>` in place of needs-human.
   - `ATTENTION`: stop.

To stop, write `attention-ci.md`. Its headline is the reason; What happened quotes the line that stopped it; Evidence lists `ci.json`, `logs/ci-failure.log`, `ci-fix.md` with its `ci-fix.round<N>.md` files, `evidence.json` and `logs/ci-fix.*.jsonl`, those that exist; the options are `/factory resume <id>` (CI is read again) and `/factory abandon <id>`. Run `run-state set stage needs-human --run <id>`. Then, but on `SUSPENDED`, which a resume carries on, run `pr-render.mjs` and `pr-open.mjs`: they label the PR needs-human and post the attention item as its comment. If either exits non-zero, print its output beside the attention item: the stop stands. Then the snapshot (see **Ending a run** in the skill); print the attention item and stop.
