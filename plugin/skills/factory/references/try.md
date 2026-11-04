# try

The factory skill reads this for `/factory try <run>`, which works on a run that has ended too. The human tries the run's change in two minutes: on the host's preview when every app the run touched has one ready at the PR's head, else on all the apps started locally, never some of each. `preview.mjs` sits beside `run-state.mjs`. Call it as `node <that directory>/preview.mjs try --run <id>`, written out in full, and print what it prints. It changes nothing in the run's state, so it needs no `run-state` call.

1. Run `preview.mjs try --run <id>` with Bash's `run_in_background`, since starting the apps can take minutes: say `Getting <id> ready to try.` and end your turn. When it wakes you, print the background task's output, ignoring the notification's own text.
   - It starts `PREVIEW`: the steps are on the preview and nothing was started. Stop.
   - It starts `LOCAL: <why>` and exited 0: the apps run locally. Ask the human to say when they're done trying it, and end your turn.
   - It exited 1 after a `LOCAL` line: the apps didn't all start. Go to step 2 now.
   - Any other exit: stop.
2. When the human is done, run `preview.mjs try --done --run <id>`, which brings the apps down, and print what it prints.
