# qa on one ticket

`references/implement.md` sends you here on a `QA <NN>: <why>` verdict: ticket `<NN>` is green and `qa` hasn't walked it since its last attempt, or it is red only in pinned tests, on which `qa` rules. Either way it is one `qa` dispatch, which costs no implement round. Call `run-stage` as `references/implement.md` does.

1. `run-state dispatch qa:<NN> --run <id>`. Print any `WARN` line it printed. If it exited 4, go to **Caps** in the skill, with the stage `qa:<NN>`.
2. Dispatch the `factory:qa` agent in the background. Pass `models.qa` from `.factory/config.json` as the model when it is set. The prompt is these four lines and nothing else:

   ```
   run_dir: <run_dir>
   worktree: <worktree>-<NN>
   ticket: <NN-slug>
   evidence: <run_dir>/tickets/<NN>/evidence.json
   ```

3. Record the agent's id from the Agent tool's result: `run-state dispatch qa:<NN> --agent <agent id> --run <id>`. Say `Walking ticket <NN> of <id>.` and end your turn.
4. When its notification arrives, ignore its text and read `<run_dir>/tickets/<NN>/qa.json`. If it's missing, doesn't parse, or its `status` isn't `done`, the stage is incomplete: write `attention-qa-<NN>.md` (headline: qa left no finished qa.json, a factory error; options: `/factory abandon <id>`), run `run-state set stage failed --run <id>`, print it and stop. Otherwise run `run-state done qa:<NN> --run <id>`.
5. `run-stage verify <NN>`: `Verifying ticket <NN> of <id>.` It runs `verify --full` in the ticket's worktree again, `qa`'s committed tests included, each with the apps up in the profile its name carries. Act on its verdict as step 1 of `references/implement.md` acts on an attempt's: `MERGE` merges, `ROUND` is a fix round whose dispatch names each failing pinned test, `QA` comes back here, and `ATTENTION` stops.
