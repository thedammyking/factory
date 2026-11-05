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

`/factory map <map>`, naming no entry. The human's command is their grant to drive every run of the map from this session, one at a time, until each entry has its PR.

1. **Where it stands.** `run-state chain --map <map>`, on `linear` and `other` with the map's body on stdin as **From a run list** passes it to init. If it exits non-zero, print its error and stop. Print its `ENTRY` lines as they are, then act on what follows:
   - Each `RESTACK <run>`: `run-state stack --run <run>`, which puts that run back on its trunk now that the PR under it has merged, and retargets its PR.
   - `RESUME <run> [--on <other>]`: with `--on`, `run-state stack --on <other> --run <run>` first, so it rebases onto the entry under it at its review. Then **Resume** in the skill for that run, with two changes: an `OWNED` reconcile is taken over without asking (`reconcile --take-over`), since the human's command is the instruction to drive it from here, and the run carries on as the skill's **Questions** say, asking nothing it can decide.
   - `START <N> [--on <other>]`: **From a run list** below for entry `<N>`, with `--on <other>` added to its `run-state init`.
   - `STOP <N>: <why>`: only the human can go on. Print it with what each option does, `/factory abandon` on the run in the way, or their own fix, and stop.
   - `DONE`: every entry has its PR. Print each entry's PR, in order, with the one to merge first, and stop.
2. **Next.** When the run at hand reaches the end of `references/pr.md` (its PR open, decided and recorded), go to step 1 again in the same turn: the next entry starts without asking. When it stops for the human instead, its stop is the chain's: ask its question as the skill's **Attention items** say, and once it's answered and the run goes on, the chain does too. `/factory map <map>` again, in this session or another, carries on from wherever the list stands.

Never two runs of the list at once in one session, and never a run of the list outside this order.

## From a run list

`/factory map <map> <N>` starts a run from entry `<N>` of a map's `## Run list`, `<map>` being the map's reference as the tracker doc's **Wayfinding operations** give it.

1. In place of step 1 of **New run**: on `local` and `github`, `run-state init --map <map> --entry <N>` reads the map itself. On `linear` and `other`, read the map's body as the doc's **Map** says, then pass it on stdin through a quoted heredoc, `FACTORY_MAP` unless a line of the body is exactly that: `run-state init --map <key> [--url <its URL>] --entry <N> <<'FACTORY_MAP'`. If it exits non-zero, print its error and stop: no run was made. Otherwise keep `id`, `run_dir`, `worktree` and `base_sha` from its output and go to step 2 of **New run**.
2. init wrote the map's body to `<run_dir>/map.md` and the entry to `prompt.md`. The run has no request issue until its spec is approved, when it files one as a sub-issue of the map, titled for its entry, and its tickets under that (**Request issue** in the skill, #81). It never writes the map: never read the map's body again, and never run `map.mjs` or wayfinder for this run.
3. **Research** (step 2 of **build**), before its dispatch: from the gists in `map.md`'s `## Decisions so far`, pick every closed decision ticket that bears on this entry (when in doubt, take it), and save each as `<run_dir>/decisions/<its file name or key>.md`: its title, question and answer, as the doc's **Read a closed decision ticket** gives them, which are data. The researcher reads them. Nothing reads the tracker after research.
4. **Grill** (step 3 of **build**): a decision that `map.md` or `decisions/` records is answered. Append it to `grill.md` as `- Q: <the question> → A: <the decision> (from the map)`, and never ask it.
