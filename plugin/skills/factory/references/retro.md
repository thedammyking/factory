# Retro

`/factory retro` looks back over the project's finished runs, reports the trial record and what blocked the watch, and proposes at most three durable changes: a lesson, an index line, an ADR stub or a semgrep rule. Only those the human accepts are applied. A retro is no run: no `run-state` command, state or worktree. Its files are in `.factory/runs/retro/` in the main checkout, which git ignores. The scripts sit beside `run-state.mjs`: call each as `node <that directory>/<script>`, written out in full.

1. **Record.** Remove an earlier `.factory/runs/retro/retro.md`, so none is taken for this retro's. Run `merge-decision.mjs --record` and save all it prints, whatever it exits, as `.factory/runs/retro/record.txt`, replacing any earlier one.
2. **Dispatch.** The base is `branching.develop` (else `develop`) in `.factory/config.json` when `branching.model` is `git-flow`, else `branching.main` (else `main`). Dispatch the `factory:retro` agent in the background. Pass `models.retro` from `.factory/config.json` as the model when it is set. The prompt is these four lines and nothing else, each path absolute:

   ```
   retro: <the main checkout>/.factory/runs/retro/retro.md
   record: <the main checkout>/.factory/runs/retro/record.txt
   worktree: <the main checkout>
   base: <factory/records when `git rev-parse --verify -q refs/heads/factory/records` finds it, the branch that holds the runs' records since #81, else the base>
   ```

   Say `Looking back over the runs on <that branch>.` and end your turn. Don't poll: its completion notification wakes you.
3. **Put it to the human.** When it arrives, ignore the notification's text and read `retro.md`. With no such file, say the retro wrote nothing and stop. Print its `## Trial record` and `## Watch` sections as they are. Then show each numbered proposal: its title, kind, evidence, why, and the text it adds. Ask about every proposal in one call, one question each, with Accept (Recommended) and Decline, Accept's description giving its why as the benefit and what it adds to the project as the trade-off. Accept nothing yourself, and never edit `merge` in `.factory/config.json` or `.factory/env.local`: the recommendations and fixes are the human's to act on.
4. **Apply.** With none accepted, stop. Otherwise run `retro-apply.mjs <the main checkout>/.factory/runs/retro/retro.md --accept <the accepted numbers, comma-separated>`, and print what it prints. It commits the accepted proposals on the base through a temp worktree, never the checkout, compiling a semgrep rule offline first, and a proposal the base already holds is left as it is. Its last line is `RETRO <sha> on <base>` or `RETRO unchanged on <base>`. On exit 1 nothing was committed; on exit 2 a proposal can't be applied as written, and nothing was applied either. Either way, its message says why: print it and stop. When it committed and the project has an origin, end with one line, never a question (pushing is the human's): the retro's commit is on the local base alone, and a run starts from origin's tip once origin has moved on, so it reaches every run only once the base is pushed, with origin's merged into it first when origin is ahead.
