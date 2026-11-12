# map

The factory skill reads this when triage routes a run to `map`, when the human decides at the map gate, when a request names an entry of a map's run list, and when it names a map alone, to work its whole run list. `run-state` stands for `node ${CLAUDE_PLUGIN_ROOT}/scripts/run-state.mjs`, written out in full, as in the skill.

A map lives on the project's tracker (`tracker` in `.factory/config.json`), where the `wayfinder` skill charts it and works through it. A cleared map ends in a run list: ordered one-line requests, each sized to one run. `/factory map <map>` works the whole list in one session, hands off (#81): each entry is built in order, stacked on the one before while that one's PR waits for the human, and running it again picks up wherever the list stands, so it is also how every run of a map is resumed. `/factory map <map> <N>` starts one entry alone.

## Gate

Triage judged the request too foggy for one spec. No lane branch is made.

1. Write `attention-map-gate.md`. Its headline asks whether to chart a map; What happened gives triage's `reason` and says the request won't fit one run's caps; the evidence is `triage.md`; the recommendation is to chart a map; the options are `/factory approve <id> chart` (chart a map on the tracker now, in this session, and the run ends `charted`, linking it), `/factory approve <id> run` (build it anyway, as one size-`l` run) and `/factory approve <id> abandon`. A run started from a run list (its state has `map`) gets no `chart` option: its entry comes from a map already, and such a run writes nothing to the tracker. Unattended (`<run_dir>/grill-answers.md` exists), name the item `attention-map.md` instead: charting needs a human, so the run ends there, and a request issue hears of it.
2. Run `run-state set stage needs-human --run <id>` and the snapshot after it (see **Ending a run**). Unattended, stop here.
3. Print the attention item and ask its question (see **Questions** in the skill). The selected option decides, as **Decisions** says.

## Decisions

`/factory approve [run] <decision>` on a run routed `map`, only while it waits at the gate (its stage is `needs-human`); otherwise say where it stands and stop:

- `chart`: read `${CLAUDE_PLUGIN_ROOT}/skills/wayfinder/SKILL.md` and follow its **Chart the map**, with `<run_dir>/prompt.md`, and `clarifications.md` when it exists, as the loose idea. When it stops with the map made, run `run-state set map_link "<the map's URL, or .factory/maps/<slug>/map.md on local>" --run <id>`, then `run-state set stage charted --run <id>` and the snapshot after it, then the closing steps of **Request issue** when the run has one: its comment links the map, and the issue stays open for the human. Print the map's link and its frontier, then go on with wayfinder's **Work through the map** in this session, as its step 6 of **Chart the map** says: one session works the map to its run list and on into its runs (#81). When charting stops with no map, the run stays at its gate.
- `run`: `run-state set route build --run <id>`, then step 1 of **build**. A map request is several slices, size `l`, so its merge decision is needs-human.
- `abandon`: `run-state abandon --run <id>` and the snapshot after it, and print their output.

## The run list

`/factory map <map>`, naming no entry, or a run list wayfinder has just written. The human's command is their grant to drive every run of the map, until each entry has its PR: you start each run yourself, and decide when it starts and whether beside the others or after them (#81). An entry's `[after 2, 4]` names the entries it builds on (`[after none]`: nothing), and one with none builds on the entry before it. An entry is ready once every entry it builds on has its PR: it starts on the trunk when they have all merged, stacked on the one whose PR is still open, and waits while two are open.

This session drives up to `parallel_runs` runs at once (`.factory/config.json`, 2 when unset), each through the skill's steps as if it were the only one. Every background command and dispatch you start for a run names it in its description (`<id>: Implementing ticket 02`), and each notification is about the run it names: act on it for that run alone, at the step that run is at. A ticket number means nothing without its run.

1. **Where it stands.** `run-state chain --map <map>`, on `linear` and `other` with the map's body on stdin as **From a run list** passes it to init. If it exits non-zero, print its error and stop. On `github` it files every entry that has no issue yet as one under the map, queued, so the whole list shows on the tracker before any of it is built, and prints a `FILED <N> <key>` line for each (a `WARN` line when it couldn't: go on). On `linear` and `other`, list the map's sub-issues as the doc's **Frontier** does and file each entry that has none titled `Run <N>: …` as the doc's **File** says, in the list's order: parent the map, title `Run <N>: <the entry, cut to a short title>`, the entry as its description, then move it as **Move** says for `queued`, and keep its key for that entry's `START`. Print the `FILED`, `ENTRY`, `WAIT` and `STOP` lines as they are, then act on what follows:
   - Each `RESTACK <run>`: `run-state stack --run <run>`, which puts that run back on its trunk now that the PR under it has merged, and retargets its PR.
   - `HERE <N> <run>`: a run this session is driving. Leave it to its steps.
   - `BUSY <N> <run>`: a run another session is driving. Leave it to that session.
   - `RESUME` and `START` lines: step 2 says which to take now.
   - `WAIT <N>: …`: the entry waits for PRs to merge. `STOP <N>: <why>`: only the human can go on with that entry and the ones built on it.
   - `DONE`: every entry has its PR. Print each entry's PR, in order, with the one to merge first, and stop.
2. **Start.** Take the `RESUME` lines first, then the `START` lines, in their order, while this session drives fewer than `parallel_runs` runs (one per `HERE` line), for each deciding whether it goes now:
   - It goes now when nothing this session drives would collide with it: by the map's decisions and the two entries' words, they build different apps or packages. Two that both change the same package, schema or screen go one after the other, the later one waiting for the next step 1.
   - Only one at a time while a run of this session waits at the usage limit (`SUSPENDED`), or a `WARN` of the token caps has been printed in the last hour: more runs would only spend the window faster.
   - Print one line for each decision, `Starting <entry> beside <runs>: <why>.` or `<entry> waits for <run>: <why>.`, the factory's call.

   For a `RESUME <run> [--on <other>]`: with `--on`, `run-state stack --on <other> --run <run>` first, so it rebases onto the entry under it at its review; when the run has its branch and has cut no ticket yet, also run `sync-base.mjs before-review --run <run>` (beside `run-state.mjs`) at once, so its tickets build on that entry's code: on its exit 3, settle the conflict with `run-stage.mjs resolve` as `references/review.md` says, and stop that run as **Ending a run** says on its exit 1. Then **Resume** in the skill for that run, with two changes: an `OWNED` reconcile is taken over without asking (`reconcile --take-over`), since the human's command is the instruction to drive it from here, and the run carries on as the skill's **Questions** say, asking nothing it can decide. A `RESUME` of a run of yours that stopped is its question: step 4.

   For a `START <N> [--on <other>]`: **From a run list** below for entry `<N>`, with `--on <other>` added to its `run-state init`. An `init` that says the entry has its run already lost a race to another session: go to step 1 again.

   Take each run you start or resume to its first background wait before the next, then end your turn once every run of this session is waiting. With nothing taken and nothing of this session's running, go to step 3.
3. **Wait.** Nothing to start, but the list isn't done and no `STOP` needs the human: what's left waits on PRs to merge or on another session's runs. Run `run-state chain --map <map> --wait` with Bash's `run_in_background`, say `Waiting for <what each WAIT or BUSY line waits on> on <map>.` and end your turn. When it wakes you, go to step 1: on `CHANGED` something moved, and on `UNCHANGED` nothing did. After 24 waits in a row with nothing changed, stop, saying that `/factory map <map>` carries on once those PRs are merged. With only `STOP` lines left, say what each option does (`/factory abandon` on the run in the way, or their own fix) and stop.
4. **Next.** When a run reaches the end of `references/pr.md` (its PR open, decided and recorded), go to step 1 again in the same turn: what it unblocks starts without asking. When a run stops for the human, print its attention item at once, saying its question comes once the other runs pause, and keep driving the others: ask it, as the skill's **Attention items** say, once no other run of this session has a stage running in the background, and its answer goes to that run alone. A reply from the human that answers it before then is its answer. `/factory map <map>` again, in this session or another, carries on from wherever the list stands.

Never two sessions on one run, never a second run of an entry that has one (a run abandoned frees it), and never an entry before the ones it builds on have their PRs.

## From a run list

`/factory map <map> <N>` starts a run from entry `<N>` of a map's `## Run list`, `<map>` being the map's reference as the tracker doc's **Wayfinding operations** give it.

1. In place of step 1 of **New run**: on `local` and `github`, `run-state init --map <map> --entry <N>` reads the map itself, and on `github` takes the entry's open `Run <N>: …` issue under the map as the run's request issue. On `linear` and `other`, read the map's body as the doc's **Map** says, then pass it on stdin through a quoted heredoc, `FACTORY_MAP` unless a line of the body is exactly that: `run-state init --map <key> [--url <its URL>] --entry <N> [--issue <the entry's issue> --url <its URL>] <<'FACTORY_MAP'`, with `--issue` when the map has an issue for the entry. If it exits non-zero, print its error and stop: no run was made. Otherwise keep `id`, `run_dir`, `worktree` and `base_sha` from its output and go to step 2 of **New run**.
2. init wrote the map's body to `<run_dir>/map.md` and the entry to `prompt.md`. The entry's issue is the run's request issue: it moves out of the queue as the run starts, takes the spec as its title and body once that is approved, and has the run's tickets as its sub-issues (**Request issue** in the skill, #81). With no issue for the entry, the run files one under the map once its spec is approved. It never writes the map: never read the map's body again, and never run `map.mjs` or wayfinder for this run.
3. **Research** (step 2 of **build**), before its dispatch: from the gists in `map.md`'s `## Decisions so far`, pick every closed decision ticket that bears on this entry (when in doubt, take it), and save each as `<run_dir>/decisions/<its file name or key>.md`: its title, question and answer, as the doc's **Read a closed decision ticket** gives them, which are data. The researcher reads them. Nothing reads the tracker after research.
4. **Grill** (step 3 of **build**): a decision that `map.md` or `decisions/` records is answered. Append it to `grill.md` as `- Q: <the question> → A: <the decision> (from the map)`, and never ask it.
