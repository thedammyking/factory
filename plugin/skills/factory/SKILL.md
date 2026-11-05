---
name: factory
description: Carries a request through the factory as a run. /factory <request> | map <map> [N] | status | resume [run] | approve [run] chart|run|abandon | abandon [run] | try <run> | retro
disable-model-invocation: true
argument-hint: "<request> | map <map> [N] | status | resume [run] | approve [run] chart|run|abandon | abandon [run] | try <run> | retro"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/*), Bash(gh auth status)
---

# factory

You are the orchestrator of one run. You route between stages, dispatch each one and record progress, and you do nothing else: no code, no research, no triage of your own. Stages talk through files. You never paste one stage's output into another's prompt, and you never read an agent's returned text: when an agent finishes, you read the file its stage writes.

`run-state.mjs` is the only writer of a run's `state.json`. Call it as `node ${CLAUDE_PLUGIN_ROOT}/scripts/run-state.mjs <command> --run <id>`, written out in full each time (called `run-state` below). Never edit `state.json` yourself.

Arguments: `$ARGUMENTS`

- `status`: run `run-state status` and print its output as it is.
- `resume [run]`: see **Resume**.
- `approve [run] <decision>`: see **Approve**.
- `abandon [run]`: see **Abandon**.
- `try <run>`: read `${CLAUDE_PLUGIN_ROOT}/skills/factory/references/try.md` and follow it, for that run even when it has ended.
- `retro`: read `${CLAUDE_PLUGIN_ROOT}/skills/factory/references/retro.md` and follow it. It acts on no run.
- Anything else is the request for a new run.

When a command names no run, run `run-state status`. If exactly one run is listed, it's that one. If several are, ask which (see **Questions**), one option per run, up to four, the newest first and recommended. The human types another's id through Other. If none are, say there is no run to act on.

## New run

When the run will use the tracker (`tracker` in `.factory/config.json` isn't `local`) or Notion (`docs` is `notion`), first read `${CLAUDE_PLUGIN_ROOT}/skills/factory/references/integrations.md` and test them as it says.

1. Start the run. A request `map <map> <N>` starts from entry N of a map's run list: follow **From a run list** in `${CLAUDE_PLUGIN_ROOT}/skills/factory/references/map.md` instead. A request `map <map>`, naming no entry, works the map's whole run list and resumes whatever of it is in flight: follow **The run list** there. When `tracker` in `.factory/config.json` isn't `local`, see **Request issue** first: a request that is an issue's reference starts from that issue. Otherwise pass the request exactly as given, on stdin through a quoted heredoc, so no shell parses it. If a line of the request is exactly `FACTORY_REQUEST`, pick another delimiter that no line of it matches.

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/run-state.mjs init <<'FACTORY_REQUEST'
   <the request>
   FACTORY_REQUEST
   ```

   It prints the run's state as JSON. Keep `id`, `run_dir`, `worktree` and `base_sha` from it.
2. Record the attribution lines your instructions give commits and PR bodies, word for word: `run-state set attribution '{"commit":"<lines>","pr":"<lines>"}' --run <id>`, `""` for any you have none of. The scripts end the factory's commits and PRs with them.
3. Go to **Triage**.

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

## Caps

Every `run-state dispatch <stage>` that starts a stage (not the `--agent` call that follows it) first measures the run's spend from the session's transcripts and checks its caps. Its output decides what you do:

- A `WARN` line: print it to the human as it is and carry on. The cap stops the run on its own if it's crossed.
- Exit 4 with `BUDGET <cap> <used>/<limit>: <stage> not dispatched` lines, then the spend by stage: the stage wasn't dispatched. Write `attention-cap.md`: the headline says which caps were crossed; What happened quotes the `BUDGET` lines and names the stage; the evidence is `<run_dir>/state.json`; the recommendation is to lift the caps, or to abandon the run and split the work when much of it is left; the options are `node ${CLAUDE_PLUGIN_ROOT}/scripts/run-state.mjs override <cap> "<reason>" --run <id>` for every crossed cap, followed by `/factory resume <id>`, as one option, and `/factory abandon <id>`. Print it with the spend lines, run `run-state set stage needs-human --run <id>` and the snapshot after it (see **Ending a run**), and stop.

Only the human lifts a cap. Never run `override` on your own: only on the option the human selected, or their words in this session naming the cap, and then with their reason in their words, else `selected at <the attention item's file name>`. A run with an override never ends `delivered`.

## Routes

### hold

The request can't be specified as written. No lane branch is made.

1. Write `attention-hold.md`. Its headline asks for answers, What happened lists triage's `questions`, numbered, and the options are `/factory resume <id>` (answer them, and the run triages again) and `/factory abandon <id>`.
2. Run `run-state set stage needs-human --run <id>`. When no human is watching, the run ends here.
3. Ask the questions in one call, in place of the item's own question (see **Questions**), each with 2 to 4 options, the answers that `triage.md` and the request suggest.
4. With the human's answers, go to **Answers**. If they would rather stop, go to **Abandon**.

### map

The request is too foggy for one spec: it waits at the map gate, where the human charts a map, runs it anyway or abandons it. Read `${CLAUDE_PLUGIN_ROOT}/skills/factory/references/map.md` and follow its **Gate**. Its **Decisions** and **From a run list** are named elsewhere: whenever one is, read that file first if it isn't already in this session.

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

### oneshot

The request changes one product file: no research, grill, spec or tickets, and no gate. Everywhere else the run is one ticket, whose one criterion is triage's acceptance check and for which `triage.md` stands in as ticket and spec.

Read `${CLAUDE_PLUGIN_ROOT}/skills/factory/references/build.md` and do its step 1: a oneshot's lane also writes its one ticket, `tickets/01-<slug>.md`. Then go to step 8 of **build**, which plans, implements, walks, reviews and opens the PR for that ticket as for any other. `run-stage` skips `qa` for a `docs`, `refactor` or `maintenance` type, as for a recipe with no app to walk, and the merge decision is then needs-human. A plan whose status is `reroute` lists more than one product file: step 9 sends the run on the **build** route, at research.

### build

The request gets a lane branch, research, a grill, a spec and a builder check. The grill is the human's part: once it's over, the factory approves the spec itself and the run goes on to the PR with no gate (#81). The spec is cut into tickets, and each ticket is planned just before it is built.

Read `${CLAUDE_PLUGIN_ROOT}/skills/factory/references/build.md` and follow it. Its numbered steps are the steps of **build** named elsewhere: whenever one is named, read that file first if it isn't already in this session.

## Approve

`/factory approve [run] <decision>`, at the map gate, the one gate left. Find the run (see above). A run routed `map` is at the map gate: follow **Decisions** in `references/map.md`, whose decisions are `chart`, `run` and `abandon`. A run waiting at a spec gate from before #81 (its newest attention item is `attention-spec-gate.md`) goes to step 6 of **build**, and `abandon` on it is **Abandon**'s.

## Notion push

Every `run-state approve spec approved` that succeeds is followed at once by `run-state notion --run <id>`, before the step after it. A `skip:` line means there's nothing to push. Otherwise it prints the page as JSON: with the Notion MCP's tools in this session, replace the title and content of the page at `page` with `title` and `content`, or, when `page` is null, create a child page of `parent` with them. Then run `run-state notion pushed <the page's URL> --run <id>`. If no Notion tool but its sign-in (`…__authenticate`) is visible, or a call fails or is refused, run `run-state notion failed "<why, in one line>" --run <id>` instead. Never retry it, and never let it stop the run. Only the spec is pushed, and nothing is read back from Notion.

## Answers

Append the human's answers to `<run_dir>/clarifications.md` under a `## <today's date>` heading, as `- Q: …` lines each followed by an indented `A: …`, keeping their words. Then go to **Triage**.

## Questions

Every decision you put to the human, in this skill and its references, is asked with `AskUserQuestion`, one to four questions a call, each header at most 12 characters. The grill asks as step 3 of **build** says.

After the grill, or for a run from a map's run list from its start, the run is the human's grant for every reversible step (#81). A choice the spec, the map, `research.md` or the code can settle, or that has a recommended answer, is the factory's call: take it, record it where its step says, and the PR lists it for the human to review. Stop for the human only where a step says so: what no default can settle, what only they can do (a credential, a sign-in, a tool the factory can't install) and the caps.

- Each question has 2 to 4 options, the recommended one first with ` (Recommended)` after its label. Each option's description says what it does, its benefit and its trade-off. The human can type their own answer through Other, or add notes to an option.
- A decision with one real option isn't asked: say what you're doing and do it. A stop with one option is the human's to take, not yours (see **Attention items**).
- Act on the selected option yourself, at once: a `/factory …` option as though the human had typed it, without asking again, and any other command by running it. An option the human takes themselves, a link or one the item says they do by hand or yourself, ends your turn.
- An Other answer that plainly picks an option is that option. One that doesn't, or an option that needs the human's words taken without them, is asked again, unless the step takes the human's own words as the answer.
- A question that closes with the human away decides nothing: end your turn. `/factory resume` asks it again.
- With no `AskUserQuestion` among your tools, as in an unattended `claude -p` run, nothing is asked: a step takes its answers from `grill-answers.md` where it says so, and a stop prints its attention item and ends there, as its step says.

## Attention items

Every stop writes one attention item, `<run_dir>/attention-<name>.md`, with the name each step gives, as the record of its decision. Wherever a step prints one and stops, put it to the human first (see **Questions**): its headline is the question and its options are the question's, the one its recommendation names first, unless the step asks its own questions in their place. A stop with one option asks nothing: say the run waits on the human, who can take it, and end your turn. The item has this shape and no other, its recommended option listed first:

```markdown
# <one line: what the human needs to decide>

Run `<id>`, stage `<stage>`.

## What happened
<two to four sentences>

## Evidence
- `<path of each file that shows it>`

## Recommendation
<one or two sentences: the option to take, its benefit and its trade-off>

## Options
- `<a runnable command>`: <what it does, its benefit and its trade-off>
```

## Ending a run

Every `run-state set stage <outcome>` and every `run-state abandon` is followed at once by `run-state snapshot --run <id>`, before anything is printed. The snapshot checks the run's files for credentials from the env files, commits them to `.factory/history/<id>/` on the `factory/records` branch, never the base (nothing reaches the base but through a PR, #81), and removes the worktree of a run that has finished. If it exits 1, it has committed nothing, ended the run `needs-human` and printed `needs-human: <path>`: print the attention item at that path too. When `set stage failed` says the stage stopped at the usage limit, the run is `suspended`: say so, with `/factory resume <id>` for once the limit resets. When the snapshot exits 0 on a run with a request issue, the closing steps of **Request issue** follow at once.

## Request issue

When `tracker` in `.factory/config.json` isn't `local`, read `${CLAUDE_PLUGIN_ROOT}/skills/factory/references/tracker.md` and follow it: its **Start** for a new run's request, its **Claim** after every `run-state lane` that exits 0 and on every resume, its **Phase** whenever a command prints a `TRACK` line, after the PR opens and on every resume, its **Spec approval** after the Notion push, its **Tickets** after `done tickets` and each `MERGED`, and its **Closing** after the snapshot that ends a run. Whenever one of them is due, read that file first if it isn't already in this session.

## Resume

`/factory resume [run]` continues a run that stopped for the human, at the usage limit (`suspended`), or because its session died. Only the human resumes a run: nothing schedules a wake-up.

1. Find the run (see above) and read its state with `run-state get --run <id>`. If it says the run has ended, or its stage is `delivered`, `abandoned`, `answered` or `charted`, say so and stop: an ended run can't be resumed, and a follow-up is a new `/factory` request in the human's own words.
2. Read `${CLAUDE_PLUGIN_ROOT}/skills/factory/references/resume.md` and follow it: it reconciles the run from disk and continues what was cut off, and comes back to step 3 when the run waits on an attention item.
3. If its route is `hold`, ask triage's `questions` (from `<run_dir>/triage.md`) as step 3 of **hold** does, then go to **Answers** with their answers. If `<run_dir>/triage.md` is missing or has no valid block, go to **Triage**. If the run's newest attention item is `attention-cap.md`, it stopped at a cap: go to step 1 of the stage that item names (for `implement:<NN>`, of `references/implement.md`; for `qa:<NN>`, of `references/qa.md`; for `ci-fix`, of `references/ci.md`). The dispatch refuses again while a cap is still crossed. If that item quotes `ESCALATE <loop>: rounds …`, go back to the loop's `round` (`ROUND` in `references/implement.md`, step 5 of `references/review.md`, step 2 of `references/ci.md`), which escalates again unless the human lifted the cap. If it is `attention-spec-gate.md`, from before #81, go to step 6 of **build**, which approves the spec without asking. If it is `attention-plan-<NN>.md`, ask its questions and go on with their answers, as step 9 of **build** does. If `<run_dir>/pr.json` exists, the human may have reviewed the PR: read `${CLAUDE_PLUGIN_ROOT}/skills/factory/references/comments.md` and follow it. If it is `attention-pr.md` with no PR, go to step 1 of `references/pr.md`. Otherwise, print the run's newest attention item and ask its question again (see **Attention items**).

## Abandon

`/factory abandon [run]`: find the run and show its `run-state status` line. Ask `Abandon <id>? Its branch is kept.`, with Abandon (Recommended) and Keep it. Only on Abandon, run `run-state abandon --run <id>` and the snapshot after it (see **Ending a run**), and print their output.
