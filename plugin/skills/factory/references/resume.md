# Resume a run

The factory skill reads this at step 2 of **Resume**. `run-state reconcile` puts the run back in a known state from disk alone: it brings the apps down, commits what a cut-off implementer left uncommitted as `wip(factory): salvaged from round N`, runs the fast checks, and says which stages are done and which were cut off. Resuming is the human's command only: never schedule a wake-up, a retry or a later resume of your own.

1. Run `run-state reconcile --run <id>` with Bash's `run_in_background`, since it runs the fast checks: `Reconciling <id>.` End your turn. When the completion notification wakes you, read the background task's output and ignore the notification's own text.
2. If it exited 6, it changed nothing:
   - `OWNED` lines: another session owns the run. Print them and ask `Take <id> over from session <session>? Only if that session is gone.` On a yes, run `run-state reconcile --take-over --run <id>` as step 1 does and go on with its output. Otherwise stop.
   - `WORKING` lines: an implementer child still runs. Say so and stop: the human resumes again once it has finished.
3. Print its `salvaged` and `verify fast` lines. Never run a stage on its `done:` line again. Continue each `CONTINUE <stage> from <sha>: <how>` line, then carry on from that stage's step as its notification would:
   - `implement:<NN>`: step 1 of `references/implement.md` for ticket `<NN>`. run-stage resumes the child's session, or starts a fresh child pointed at the git log since `<sha>` and at its report.
   - `resume agent <agent id>`: leave an agent this session still has running. If the stage's file already holds what its step reads, the agent finished before the stop: read the file as its step does. Otherwise send the agent `You were cut off. Carry on and finish <the stage's file>.` with SendMessage, end your turn, and read the file on its notification. If the agent can't be reached, dispatch the stage fresh.
   - `fresh`: dispatch the stage again as its step does. A cut-off review is always fresh, and so is a stage a failed run judged incomplete.
4. With no `CONTINUE` line:
   - A run whose stage is `needs-human` or `failed` waits on its attention item: go to step 3 of **Resume**.
   - Any other stopped between stages: go on at the step after the last stage on the `done:` line, in the order the skill runs them. Past the ticket gate, take the frontier's `STARTED` lines in order: a ticket with `implement:<NN>` on the `done:` line gets step 5 of `references/qa.md`, `run-stage verify <NN>`, which judges it again and prints its verdict; one with only `plan:<NN>` gets the check before step 1 of `references/implement.md`; any other is planned, step 10 of **build**. A `WAIT` line's ticket with only `plan:<NN>` on the `done:` line gets that check too. Then go to step 9 of **build** for the `NEXT` lines.
