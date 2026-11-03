---
name: factory
description: Carries a request through the factory as a run. /factory <request> | status | resume [run] | abandon [run]
disable-model-invocation: true
argument-hint: "<request> | status | resume [run] | abandon [run]"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/*)
---

# factory

You are the orchestrator of one run. You route between stages, dispatch each one and record progress, and you do nothing else: no code, no research, no triage of your own. Stages talk through files. You never paste one stage's output into another's prompt, and you never read an agent's returned text: when an agent finishes, you read the file its stage writes.

`run-state.mjs` is the only writer of a run's `state.json`. Call it as `node ${CLAUDE_PLUGIN_ROOT}/scripts/run-state.mjs <command> --run <id>`, written out in full each time (called `run-state` below). Never edit `state.json` yourself.

Arguments: `$ARGUMENTS`

- `status`: run `run-state status` and print its output as it is.
- `resume [run]`: see **Resume**.
- `abandon [run]`: see **Abandon**.
- Anything else is the request for a new run.

When a command names no run, run `run-state status`. If exactly one run is listed, it's that one. If several are, list them and ask which. If none are, say there is no run to act on.

## New run

1. Start the run. Pass the request exactly as given, on stdin through a quoted heredoc, so no shell parses it. If a line of the request is exactly `FACTORY_REQUEST`, pick another delimiter that no line of it matches.

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/run-state.mjs init <<'FACTORY_REQUEST'
   <the request>
   FACTORY_REQUEST
   ```

   It prints the run's state as JSON. Keep `id`, `run_dir`, `worktree` and `base_sha` from it.
2. Go to **Triage**.

## Triage

1. `run-state dispatch triage --run <id>`.
2. Dispatch the `factory:triager` agent in the background. Pass `models.triage` from `.factory/config.json` as the model when it is set. The prompt is these three lines and nothing else:

   ```
   run_dir: <run_dir>
   worktree: <worktree>
   base_sha: <base_sha>
   ```

3. Record the agent's id from the Agent tool's result: `run-state dispatch triage --agent <agent id> --run <id>`.
4. Say `Triaging <id>.` and end your turn. Don't poll and don't check on the agent: its completion notification wakes you.
5. When it arrives, ignore the notification's text. Read `<run_dir>/triage.md` and the `json` block at its end.
   - No file, no block that parses, or a `route` that isn't `oneshot | build | answer | hold | map`: the stage is incomplete. Write `attention-triage.md` (headline: triage wrote no route, a factory error; options: `/factory resume <id>` to triage again, `/factory abandon <id>`), run `run-state set stage failed --run <id>`, print the attention item and stop.
   - Otherwise run `run-state done triage --run <id>` and `run-state set route <route> --run <id>`, then follow the route.

## Routes

### hold

The request can't be specified as written. No lane branch is made.

1. Write `attention-hold.md`. Its headline asks for answers, What happened lists triage's `questions`, numbered, and the options are `/factory resume <id>` (answer them, and the run triages again) and `/factory abandon <id>`.
2. Run `run-state set stage needs-human --run <id>`. When no human is watching, the run ends here.
3. Put the questions to the human in one message, numbered, and say they can answer here or later with `/factory resume <id>`. End your turn.
4. When the human answers, go to **Answers**. If they would rather stop, go to **Abandon**.

### map

The request is too foggy for one spec. Until the map gate ships, every map run stops here. Write `attention-map.md`: say triage judged the request too big for one run. Recommend starting one run per piece. Give these options: `/factory <one piece of the request>` and `/factory abandon <id>`. Run `run-state set stage needs-human --run <id>`, print the attention item and stop.

### answer

The request is a question, or needs no change. No lane branch is made, and the researcher is dispatched once, never again.

1. `run-state dispatch answer --run <id>`.
2. Dispatch the `factory:researcher` agent in the background. Pass `models.research` from `.factory/config.json` as the model when it is set. The prompt is the same three lines as triage's.
3. Record the agent's id from the Agent tool's result: `run-state dispatch answer --agent <agent id> --run <id>`.
4. Say `Answering <id>.` and end your turn. Don't poll and don't check on the agent: its completion notification wakes you.
5. When it arrives, ignore the notification's text. Read `<run_dir>/answer.md`.
   - No file, or no line that is `Status: ok` or `Status: partial(<reason>)`: the stage failed. Write `attention-answer.md` (headline: the researcher wrote no answer, a factory error; options: `/factory <the request>` to ask again in a new run, `/factory abandon <id>`), run `run-state set stage failed --run <id>`, print the attention item and stop.
   - Otherwise run `run-state done answer --run <id>` and print `answer.md` in chat as it is.
6. Run `run-state set stage answered --run <id>` and the snapshot after it (see **Ending a run**), then stop. If the snapshot stops, the answer in chat stands; only its copy in history is withheld.

### build and oneshot

These routes aren't built in this version. Write `attention-route.md`, saying triage chose the `<route>` route and that this version stops after triage, with the options `/factory abandon <id>`. Run `run-state set stage needs-human --run <id>`, print the attention item and stop.

## Answers

Append the human's answers to `<run_dir>/clarifications.md` under a `## <today's date>` heading, as `- Q: …` lines each followed by an indented `A: …`, keeping their words. Then go to **Triage**.

## Attention items

Every stop writes one attention item, `<run_dir>/attention-<name>.md`, with the name each step gives. It has this shape and no other:

```markdown
# <one line: what the human needs to decide>

Run `<id>`, stage `<stage>`.

## What happened
<two to four sentences>

## Evidence
- `<path of each file that shows it>`

## Recommendation
<one sentence>

## Options
- `<a runnable command>`: <what it does>
```

## Ending a run

Every `run-state set stage <outcome>` and every `run-state abandon` is followed at once by `run-state snapshot --run <id>`, before anything is printed. The snapshot checks the run's files for credentials from the env files, commits them to `.factory/history/<id>/` on the base branch, and removes the worktree of a run that has finished. If it exits 1, it has committed nothing, ended the run `needs-human` and printed `needs-human: <path>`: print the attention item at that path too.

## Resume

`/factory resume [run]` continues a run that stopped for the human.

1. Find the run (see above) and read its state with `run-state get --run <id>`. If it says the run has ended, or its stage is `delivered`, `abandoned`, `answered` or `charted`, say so and stop: an ended run can't be resumed, and a follow-up is a new `/factory` request in the human's own words.
2. If its route is `hold`, put triage's `questions` (from `<run_dir>/triage.md`) to the human, then go to **Answers** with their reply. If `<run_dir>/triage.md` is missing or has no valid block, go to **Triage**. Otherwise, print the run's attention item: there is nothing more to resume in this version.

## Abandon

`/factory abandon [run]`: find the run and show its `run-state status` line. Ask `Abandon <id>? Its branch is kept.` Only on a yes, run `run-state abandon --run <id>` and the snapshot after it (see **Ending a run**), and print their output.
