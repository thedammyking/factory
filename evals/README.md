# Evals

`claude plugin eval` cases for the agent prompts the plugin ships ([#20](https://github.com/thedammyking/factory/issues/20)). Each case plants one problem and checks that one agent handles it. They run by hand before a version is tagged, from the repo root, against `plugin/`, and never ship.

| Case | Planted input | Passes when |
|---|---|---|
| `triager-ambiguous` | "Make the dashboard better." | `triage.md` has `contract: NEEDS_CLARIFICATION`, route `hold` and one to three questions |
| `triager-crm` | "Build me a CRM." on an empty repo | route `map` |
| `triager-one-file-bug` | a cart total that ignores quantity, in one file | `READY`, route `oneshot` |
| `triager-not-oneshot` | "Show the user's timezone on their profile card", which needs a component change and an API change | route `build` |
| `researcher-local-doc` | a question `docs/auth.md` answers | `answer.md` cites `docs/auth.md`, and WebFetch is called zero times |
| `builder-check-uncheckable` | a spec whose `SC-003` says only "The export feels fast." | the last message and `builder-check.md` name `SC-003` |
| `planner-plan-test-first` | a ticket adding a CSV export to a small repo with a `node:test` seam | `tickets/01/plan.md` is written, names a path the repo holds, and (judged by `llm`) writes a failing test before the change |
| `implementer-red-pinned` | a ready plan for that CSV export, with the pinned test `e2e/r1-01-csv-export.test.mjs` red, in a run and ticket worktree laid out as `run-state` and `run-stage` make them | `node --test` in the ticket's worktree ends `# fail 0` with the pinned test passing, the pinned file is byte for byte as written and never the target of an Edit or Write, and the ticket's branch has a commit |
| `qa-wrong-value` | a ticket whose criterion `SC-001` says the seeded cart totals `4250`, against a `node:http` app answering `2750`, in the same run and ticket layout | the pinned test `e2e/r1-01-cart-total.test.mjs` carries the factory's header and the `[r1] SC-001:` title, asserts `4250` outside its title and never mentions `2750`, and `qa.json` records `SC-001` `fail` |
| `reviewer-code-dropped-error` | a diff whose checkout swallows a failed order save, so a customer is charged for an order that's lost, with an `implementation.md` that calls it deliberate | `review-code.md` has a P0 or P1 finding located at `src/checkout.js` |
| `reviewer-ui-overflow` | the six captures of an invoice page whose heading runs past the right edge at 390 px, with `overflow: true` there in `states.json` | `review-ui.md`'s disposition is `fix` or `rebuild`, past check 0, and a finding is located at a 390 px capture |
| `reviewer-security-sql-template` | an admin-only search whose SQL is built from the search term by a template literal, with no SAST in `security.json` | `review-security.md` has a P0 or P1 finding with a CWE |

Every case also checks that the session dispatched the agent under test.

## Release

From the repo root, with `<version>` the version about to be tagged:

```
claude plugin eval . --ablation none --scaffold --allow-tools Bash Write Edit WebFetch --runs 3 --threshold 1 --model claude-haiku-5-5 --judge-model claude-haiku-5-5 --no-publish --output-dir evals/results/<version>
```

Exit 0 is required before tagging. A failing case is fixed, in the prompt or the case, never waved through. Then `node evals/compare.mjs` prints each case's score and mean cost per eval run next to the last committed release, marks any case more than 20% dearer, and prints both results' Claude Code versions and pinned models. It never fails: a human judges a rise. Commit `evals/results/<version>/aggregate-result.json` with the tag. Every other result is gitignored.

- `--model` pins only the session that dispatches the agent. The agents keep their frontmatter model (fact 3), so the `sonnet` alias moves with the Claude Code version that `compare.mjs` prints.
- `--judge-model` is pinned for the cases that grade prose. Only `planner-plan-test-first` does, with one `llm` grader on whether the plan's failing test comes first; every other grader is `regex`, `file_exists` or `tool_used`.
- WebFetch is granted so the researcher could fetch. Its no-fetch grader means nothing if the tool is absent.
- While editing one agent, rerun only its cases with `--case 'triager-*'`. `--case` takes one glob.

## Writing a case

A case is a directory holding `case.yaml` (`plugins: ["../../plugin"]` and the scaffold), `prompt.md` and `graders/`. The prompt dispatches the agent in the foreground with the three lines the factory skill sends: `run_dir: .factory/runs/r1`, `worktree: .` and `base_sha: HEAD`. `scaffold.sh` writes the whole workspace from heredocs: a tiny repo, `.factory/config.json` and `setup.json`, and the run-dir files the agent reads, which `.gitignore` keeps out of git. It ends with the commit. No case shares a fixture or reads outside its own folder.

The implementer is the exception: `run-stage` starts it, not the skill, and it needs a run's real layout for `verify --fast` and `guard-paths`. Its case sends the five lines `run-stage` sends (`run_dir`, `worktree`, `ticket`, `plan`, `implementation`), each relative to the workspace, and its scaffold, after the commit, adds the run's worktree with its run dir and `state.json`, then the ticket's worktree on `factory/r1/01`. `qa` works on a ticket's worktree too, for `verify --pinned`, so its case has the same layout and sends the four lines `references/qa.md` sends (`run_dir`, `worktree`, `ticket`, `evidence`).

## Eval facts

Each fact was proven by a probe before the cases relied on it, recorded the way [docs/platform-facts.md](../docs/platform-facts.md) records the platform facts. Every probe ran on Claude Code 2.1.317 on macOS (Darwin 27.0.0) on 2026-11-03, as a throwaway case under `evals/`, with `--ablation none --runs 1 --model claude-haiku-5-5`.

### 1. A case loads the plugin through `plugins: ["../../plugin"]`

- **Claim.** A case under `evals/` at the repo root, run with the repo root as the target, loads the plugin in `plugin/`.
- **Docs.** [Plugin evals](https://code.claude.com/docs/en/plugin-evals.md): `plugins` lists "Plugin directories under test, relative to the case directory". They don't say whether the target may be a folder with no manifest, like the repo root.
- **Probe.** `claude plugin eval .` from the repo root, with a case whose `case.yaml` sets `plugins: ["../../plugin"]`. Pass: the plugin's agents are listed in the run's init event.
- **Result.** Holds. The command reports `Plugin under test: "factory"` at `plugin/`, although the root has no `plugin.json`. Each run's init event lists the `factory:triager` and `factory:researcher` agents. Results land in `evals/results/` at the root. The fallback, evals inside `plugin/`, isn't needed.

### 2. Bash inside an eval reaches a `localhost` server on macOS

- **Claim.** A command run through the Bash tool in an eval can serve on a local port and reach it at `localhost`, as the `qa` case needs.
- **Docs.** [Plugin evals](https://code.claude.com/docs/en/plugin-evals.md): granted Bash runs under the OS sandbox, with "network access is limited to domains you grant with `--allow-tools "WebFetch(domain:example.com)"`". They don't mention local ports.
- **Probe.** The scaffold starts a `node:http` server with `nohup … &` and writes its port to a file. The case's Bash then starts a second server the same way and curls both at `localhost`, and the first one also at `127.0.0.1`. The probe was repeated with `WebFetch`, `WebFetch(domain:localhost)` and `WebFetch(domain:127.0.0.1)` granted. Pass: a curl returns a server's reply.
- **Result.** Doesn't hold.
  - The server started from Bash fails at `listen` with `EPERM`, because the run's sandbox has local binding off.
  - Every curl of the scaffold's server fails with exit 7 (couldn't connect), although that server was still running.
  - None of the grants changes this. The setting that would allow it, `sandbox.network.allowLocalBinding`, lives in settings an eval run doesn't load.
  - So a case can neither start nor reach a local server from Bash, and the `qa` case can't be built on it.

### 3. `--model` doesn't override an agent's frontmatter model

- **Claim.** `--model` sets the model of the session under test, and an agent it dispatches keeps the model its frontmatter names.
- **Docs.** [Plugin evals](https://code.claude.com/docs/en/plugin-evals.md): `--model` is the "Model for the agent under test". They don't mention subagents.
- **Probe.** `triager-ambiguous` and `researcher-local-doc` run with `--model claude-haiku-5-5`, and each run's trace is read. Both agents declare `model: sonnet`. Pass: the agents' messages come from a Sonnet model.
- **Result.** Holds. The dispatching session ran on `claude-haiku-5-5`, and both agents ran on `claude-sonnet-5-5`. The trace's assistant messages name each model, and the run's `modelUsage` lists both.

### Found on the way

On the same version and date:

- `tool_used` counts a subagent's calls, not only the session's. The trace holds them, and a `Write` grader on `answer.md` counted the researcher's write, which no other agent made. That is what lets `WebFetch` `max: 0` grade the researcher.
- A run's `costUsd` already includes its judge calls, which `judgeCostUsd` repeats. A one-run case with an `llm` grader reported the same `costUsd` for the run as for the whole suite.
- `git` inside an eval's Bash fails on macOS.
  - The lookup lands on `/usr/bin/git` even with Homebrew's git first on `PATH`.
  - That shim exits 72, because the sandbox denies its cache under the user's temp dir.
  - The triager and the researcher then list the files some other way. Without being told how, the triager held `triager-not-oneshot` in 2 of 5 eval runs, so its prompt now names Glob as the fallback.
  - A later case whose agent must run git, such as the implementer's commit, hits this too.

### Not yet run

`implementer-red-pinned` was built in an agent worktree, where `claude plugin eval` can't run, so no run of it has been graded. Its scaffold was run by hand and the test command run before and after a hand-made fix: the graders' patterns failed before it and passed after. In that layout `verify --fast` ran green from the ticket's worktree, and `guard-paths` denied an implementer's Edit of the pinned file. The implementer must commit, and `verify --fast` calls git, so on macOS the case meets the git failure above. Git's exit 72 didn't reproduce in a `claude -p` child given `{"sandbox":{"enabled":true}}` through `--settings` (2.1.317, 2026-11-04): `git status` and `git commit` both exited 0. Whether that child's sandbox engaged wasn't checked, so this says nothing yet about an eval run's. Its first run decides: if `committed` fails with git exiting 72, the case passes only where the eval's Bash can run git, such as Linux. Run it alone with `--case 'implementer-*'` in the release command.

`qa-wrong-value` was built the same way and hasn't been graded either. Its scaffold was run by hand, a hand-written pinned test asserting `4250` was put where `qa` writes it, and `verify --pinned` on it, from the workspace root, brought the app up on its own port and failed it with `{ total: 2750 }` against `{ total: 4250 }` in the digest. Each grader's pattern matched that test and a `qa.json` recording `SC-001` `fail`, and failed the same test asserting `2750`, a title without `[r1]`, and `SC-001` recorded `pass`. Two eval facts stand in its way on macOS: by fact 2 the app can't come up or be reached from the eval's Bash, so `qa` can only record `SC-001` `blocked`, `environment`, and `records-fail` fails; and `qa`'s commits and `verify` meet the git failure above. Its first run decides which graders hold where: `holds-spec-value`, `not-the-observed-value` and `pinned-as-named` grade the test `qa` writes before it opens the app, so they don't need either. Run it alone with `--case 'qa-*'` in the release command.
The three `reviewer-*` cases were built in an agent worktree too, and haven't been graded either. Each scaffold was run by hand, and each grader's pattern matched a hand-written lens file in the schema that should pass and missed one that shouldn't. Their lenses need no git. The UI case's captures were rendered at 1x by headless Chrome from a page laid out as its diff's, then re-encoded as palette PNGs, and its scaffold decodes them with `base64 --decode`. Run them with `--case 'reviewer-*'` in the release command.
