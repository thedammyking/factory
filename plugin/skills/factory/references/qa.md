# Walk the run

`references/review.md` sends you here once every ticket is merged into the run branch and `verify --full` has judged its head: `qa` walks the run's success criteria in the running app, once for the whole run (#81). It rules on red pinned tests, pins each criterion and runs it, and a criterion that fails is a finding the review's fix round fixes with the lenses' findings. It costs no round. On `REVIEW … qa …`, `review.md` sends you here again with the criteria the fix round was for.

A docs, refactor or maintenance oneshot has no walk, and nor does a run whose recipe has no app with a `dev` command: go back to `review.md`'s step 1. Its checks are its proof, and the merge decision is needs-human (#24).

1. `run-state dispatch qa --run <id>`. Print any `WARN` line it printed. If it exited 4, go to **Caps** in the skill, with the stage `qa`.
2. Dispatch the `factory:qa` agent in the background. Pass `models.qa` from `.factory/config.json` as the model when it is set. The prompt is these three lines, and on a walk again a fourth, `criteria: <SC-###, …>`, the criteria of the open qa findings in `findings.json`:

   ```
   run_dir: <run_dir>
   worktree: <worktree>
   evidence: <run_dir>/evidence.json
   ```

3. Record the agent's id from the Agent tool's result: `run-state dispatch qa --agent <agent id> --run <id>`. Say `Walking <id>.` and end your turn.
4. When its notification arrives, ignore its text and read `<run_dir>/qa.json`. If it's missing, doesn't parse, or its `status` isn't `done`, the stage is incomplete: write `attention-qa.md` (headline: qa left no finished qa.json, a factory error; options: `/factory abandon <id>`), run `run-state set stage failed --run <id>`, print it and stop. Otherwise run `run-state done qa --run <id>`.
5. `verify.mjs --full` with Bash's `run_in_background`, which runs `qa`'s committed tests with the rest: `Verifying <id> with its pinned tests.` End your turn, and when it wakes you, go back to `review.md`'s step 1. A red there that the run introduced is the fix round's, with the lenses' findings.
