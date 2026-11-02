# Review of the starting drafts

Checked against `docs/design/design.md` (fixes 1–26) and `docs/design/brief.md` (stages 1–18 and the non-negotiable rules). Every script passes `node --check` / `bash -n`. They were run against a copy of the test bed's finished run. GitHub calls went to a `gh` shim with canned JSON, and pushes went to a local bare remote, so nothing was written to the network. Statuses are: works, fixed, gap (a defect left for the build) and untested (with what it needs).

## Files

### Agents
- `agents/builder-check.md`: **works**. It reads the spec cold and returns at most 8 questions, each with a default (brief stage 5).
- `agents/implementer.md`: **fixed**. It had no test-first rule; it now has test-first, plus the bug's failing regression test committed on its own first. It also pointed at the dry run's vendored `.factory/scripts/verify.mjs`.
- `agents/planner.md`: **fixed**. Success criteria now carry a `profile:` tag and a `live-safe` mark (fix 4 and post-merge smoke need them). The plan gains a `## UI states` list for `capture-states.mjs` (fix 11), and also covers tracking-plan names and `design-ref.md` (brief stages 4 and 7). The tickets path is still tracked; see gaps.
- `agents/pr-writer.md`: **gap**. `pr-render.mjs` replaced it (fix 10). It still reads the `review.md` prose instead of `findings.json`, and it would overwrite the rendered `pr.md`. Decide whether to keep it as an optional polish pass or delete it.
- `agents/qa.md`: **fixed**. The pin path was hard-coded to the test bed's `apps/web/e2e/`. It had no profile walk (fix 4), no mobile-mcp driver (brief stage 10) and no `blocked: budget`. The touch context and clipboard rules (fix 23) were already there.
- `agents/researcher.md`: **works**. It is read-only, treats fetched pages as data, caps output at 300 lines, and records `partial` when a fetch fails.
- `agents/retro.md`: **fixed**. Its inputs named dry-run files (`review-round2.md`, `review-ui-round2.md`) that the `round<N>` convention never produces. It now reads `post-merge:` lines first and adds golden tasks (brief stage 18). It also states the section format that `retro-apply.mjs` parses.
- `agents/reviewers.md`: **fixed**. Re-reviews had no instruction to close findings with `status: closed` blocks, which fix 16's resolution ledger depends on, and were not scoped to the fix diff (brief stage 12). Some design checklist items are still missing; see gaps.
- `agents/triager.md`: **fixed**. It hard-coded git-flow. The lane now comes from `config.json` `branching`, and trunk mode is covered (brief F).

### Scripts
- `scripts/capture-states.mjs`: **untested: needs** Playwright installed globally with Chromium, plus a running web app. Reading it confirms fix 11 (animations settled, clipboard granted) and fix 23 (`hasTouch` at ≤ 600 px).
- `scripts/ci-watch.mjs`: **fixed**. All five outcomes ran with the shim. When the base was red for a different step, `cause` came out `undefined` (fix 17 says `ours` plus a note); this pass fixed that. The "same workflow" test was always true (`filter` used where `every` was meant). `base_branch` was spliced into a shell string.
- `scripts/classify-diff.mjs`: **fixed**. Its built-in defaults were the old substring rules: without a project `touch-rules.json` they fired `auth` and `files` on the test bed's diff, which is what fix 9 removed. They also counted `.factory/` bookkeeping (scripts, tickets) as product. It now fires data, network, crypto and api_contract, and not auth or files. A top-level `auth/` now matches as a segment.
- `scripts/guard-paths.mjs`: **fixed**. The original passed all twelve fix-5 cases. It failed the rest:
  - a symlinked directory or file let a write escape the worktree;
  - `> ../../x` escapes were not caught;
  - during a run it denied reads and script calls, e.g. `cat .factory/setup.json | grep perform`, or `node ~/.claude/plugins/.../verify.mjs 2>&1`.
  Paths are now realpath-resolved and writes through symlinks are refused. The protected regex checks only write targets, and Write/Edit to `/tmp` is allowed as the design says. `scripts/guard-paths.test.mjs` (new) passes 20/20.
- `scripts/merge-decision.mjs`: **fixed**. It read the *first* `assessment:` block in `implementation.md`, but every round appends one, so the facts used the oldest round. Branch names and SHAs went through a shell. Facts 2, 21, 12/13 and `ci_green_at_head` hold.
- `scripts/post-merge.mjs`: **fixed**. CI-only, CI + deployment + smoke, and CI-red → revert all ran with the shim. The revert path made a `git revert -m 1` on `revert/<run>-<sha>` and opened a PR labelled `factory` + `needs-human`, never merged. Target, SHA and run id went through a shell. The trailer was a past session's hard-coded attribution.
- `scripts/pr-comments.mjs`: **fixed**. Any GitHub user could raise a P1 `fix`. Only OWNER, MEMBER or COLLABORATOR (or a login in a `setup.json` `reviewers` list) is actionable now. Everyone else is a P3 `note` that shows the author, and untrusted replies are dropped from a trusted thread's claim. Fixes 18 and 19 hold: stable ids, marker filter, and one review open with two resolved.
- `scripts/pr-inputs.mjs`: **fixed**. It carried test-bed values: six capture filenames, a rate-limit hint, `pnpm install` and `-- apps` pathspecs. The `assessment` regex dumped the rest of `implementation.md` into the PR body (22 kB → 11 kB).
- `scripts/pr-open.sh`: **fixed**. With the shim it creates a draft PR over REST with labels and `attention.md` as the first comment, marked. It still called `gh repo view` (GraphQL), spliced paths into `node -e`, hard-coded a past session's trailer, and located the project from the script's own directory.
- `scripts/pr-render.mjs`: **works**. Fix 26 holds: SC-013 reads "open `/`".
- `scripts/pr-resolve.mjs`: **fixed**. It resolved the thread on GitHub even when the reply had failed (fix 20 needs reply-then-resolve). It now resolves only after the reply posts. A retry after a failure works.
- `scripts/preview.mjs`: **fixed**. A request title of `$(touch …)` ran in the `command` mode. `{branch}`, `{sha}` and `{title}` now reach the shell only as quoted `$FACTORY_*` env refs. The deployment success and failure paths, `command`, `fixed` and `local` all ran with the shim.
- `scripts/retro-apply.mjs`: **fixed**. On a base with no `.factory/semgrep/` it applied the two accepted proposals (creating the directory), the third was already on the base, and a second run was a no-op (fix 25). It staged a hard-coded `lessons.md` + `project.yaml` pair instead of the files it changed, accepted targets outside the repo, and spliced the base branch into a shell. The offline semgrep compile is untested because semgrep is not installed.
- `scripts/review-package.sh`: **fixed**. Its pathspec was the test bed's `apps …`: another layout would get an empty diff, and the root `vitest.config.ts` was missing. It now takes everything except factory bookkeeping, keeping the recipe.
- `scripts/run-apps.sh`: **gap**. It hard-codes the test bed's two apps, `pnpm`, ports and `/api/health`, ignores `.factory/env.local`, and its `fuser -k <port>/tcp` is Linux-only. This pass fixed one thing: a profile value containing a space ran as a command (`env -i … $API_ENV`). Untested: needs `pnpm install` (node_modules).
- `scripts/run-state.mjs`: **fixed**. init, dispatch, done, spend, round, override, archive-review, abandon and snapshot all ran on a temp run. Problems found:
  - A repeat snapshot with nothing new crashed and leaked a worktree, so every later snapshot failed (fix 24).
  - A `tokens` override also lifted the post-PR allowance, so the test bed's own state never stopped at 400k (fix 13). It now has its own `post_pr` override.
  - The trailer was hard-coded.
  - `round` produced NaN on states without `rounds.ci`.
- `scripts/security-scan.sh`: **fixed**. It ran with stubbed scanners. On macOS it wrote invalid `security.json`, because BSD `sed` has no `\s` and the values were not JSON-escaped. Other defects: `apps` pathspecs, no `timeout` on macOS, and a path spliced into `node -e`. Real gitleaks, semgrep and audit runs are untested.
- `scripts/sync-base.sh`: **fixed**. Every path ran: rebase, rebase conflict, local merge conflict, update-branch accepted and update-branch refused. Each conflict aborted and wrote `attention-sync.md` with the branch untouched (fix 22). Defects found:
  - With `ACTIVE` missing, its restore trap would `rm -rf .factory/runs/`.
  - After update-branch's async 202 it claimed "merged" before the merge arrived.
  - It found the project from the script's own location (run from the plugin, it acted on the wrong repo).
  - It spliced a path into `node -e` and took the base branch unchecked (`--exec=` option injection into `git rebase`).
- `scripts/synthesize.mjs`: **fixed**. The fix 3 groups and 12 resolutions (fix 16) reproduce exactly. The UI rule (fix 6) was broken: a `ui-disposition` resolution from round 2 closed the round-3 lens's `disposition: fix`, which no UI re-review ever approved. On the test bed's data it now shows as an open P1. `rebuild` and `recapture` count as not-ship.
- `scripts/verify.mjs`: **untested: needs** `pnpm install` (node_modules) and Playwright browsers for the recipe's e2e check. It was fixed and its mechanics were checked with a stub recipe:
  - `{base}` was spliced into `bash -lc`; a base of `$(touch …)` ran.
  - Checks inherited the developer's shell and login profile instead of `.factory/env.local` only.
  - The fix 15 `run-apps.sh down` only ran when scripts were vendored into the project.
  The dirty, trusted and missing-check behaviour holds.

### Config
- `config.json`: **works**. Caps match the brief (3/2/1 rounds, 30 dispatches, 90 + 45 min, 700k + 700k tokens) and the merge policy is `trial`. It has no `qa.drivers.mobile` entry, so the mobile driver is implied.
- `touch-rules.json`: **works**. Fix 9's re-classification holds with it.

## Security fixes in this pass
- Shell-string injection, from values in the run or the recipe:
  - `preview.mjs`: `{title}`, `{branch}` and `{sha}`.
  - `verify.mjs`: `{base}`.
  - git calls in `merge-decision.mjs`, `run-state.mjs` (snapshot), `retro-apply.mjs`, `post-merge.mjs`, `ci-watch.mjs`, `classify-diff.mjs` and `pr-inputs.mjs`, now argument lists.
  - Paths spliced into `node -e` in `sync-base.sh`, `pr-open.sh` and `security-scan.sh`.
  - Word-split profile env in `run-apps.sh`.
- Option injection: branch names are checked before git write commands in `sync-base.sh`, `run-state.mjs`, `retro-apply.mjs` and `post-merge.mjs`.
- `guard-paths.mjs`: realpath containment, symlink targets refused, relative escapes caught.
- `pr-comments.mjs`: only collaborators can raise `fix` or `ask`.
- `retro-apply.mjs`: proposal targets must stay inside the repo.
- `sync-base.sh`: no `rm -rf .factory/runs/` without an active run.

## How the 26 fixes stand
- **Held as written:** 1, 2 (merge rule), 3, 5, 7, 10, 12, 14, 18, 19, 21, 26.
- **Broken, now restored:**
  - 2: bookkeeping was still in classify-diff, review-package, pr-inputs and security-scan.
  - 6: a stale resolution masked an open fix.
  - 9: the built-in defaults were the old substring rules.
  - 13: the post-PR cap was lifted by the build-tokens override.
  - 15: run-apps down only ran with vendored scripts.
  - 16: re-reviews had no closure format.
  - 17: `cause` was undefined when the base was red for another step.
  - 20: the thread was resolved without a reply.
  - 22: async race, data-loss path.
  - 24: a repeat snapshot crashed.
  - 25: wrong files staged.
- **Not exercisable here:** 4 (needs the apps running), 8 (needs the real scanners), 11 and 23 (need Playwright).

## Gaps the build must close
1. **Run directory inside temp worktrees.** Every script finds `.factory/runs/` under the current worktree. In a temp worktree (where the brief says branch work happens) the untracked run dir is not there. Resolve it from the main worktree.
2. **Base branch checked out elsewhere.** `snapshot` and `retro-apply` do `git worktree add <base>`, which fails when the base is checked out in another worktree, for example a live clone on `develop`. The test reproduced this.
3. **Attribution lines.** The orchestrator must export `FACTORY_COMMIT_TRAILER` and `FACTORY_PR_TRAILER` from the session's required lines. The scripts now refuse to commit or open a PR without them.
4. **`run-apps.sh` must be rewritten from `setup.json`.** Start every app, build the env from `env.local` merged with the profile, and kill by port portably (`lsof -ti`).
5. **Review-thread resolution relies on proxy-only routes.** The `ccr/` routes exist only behind the session proxy, and REST has no equivalent. Outside a cloud session, human threads never resolve. Choose GraphQL with a fallback, or accept the limit.
6. **Tickets and plans are tracked files.** They are written to `.factory/tickets/` during a run, against the brief's rule that no tracked file is written during a run. Pick a run-dir location that is snapshotted to `history/`.
7. **`run-state.mjs` is incomplete.** It lacks `reconcile` and `next-ticket` (design), the `ACTIVE` file holds only the id (design: id, branch, session, started-at), and there is no 70 % minutes warning.
8. **Design merge facts are missing.**
   - The PR must target the run's base.
   - A touched app's `github-deployment` preview must reach `success`.
   - Blast-radius and migration limits.
   - An explicit conflict check.
   - `security.json` `findings` is never filled, so `no_high_security` is vacuous; high and critical issues surface only as a failed capability.
9. **`preview.json` entries lack status.** They have no `status: ready|failed|timeout|none`, and a failed deployment still waits out `wait_seconds`.
10. **`security-scan.sh` assumes npm or pnpm.** It needs a `missing` vulnerabilities capability for other stacks. Also prove the offline semgrep compile and the real scanners.
11. **Human-lens nits are deferred.** `nit:`/`optional` → P3 `fix` is deferred and never blocks, but the brief says a change request is P1 `fix`. Decide.
12. **The oneshot route has no verify steps.** It has no spec, so "Verify in 2 minutes" comes out empty; use triage's `acceptance_check`. The preview prints as raw JSON instead of URLs inside the steps.
13. **`reviewers.md` is missing design rules:**
    - the critique rubric's numeric floor (fix 6);
    - an endpoint added without `auth` or `data` firing is a P1 `ask`;
    - flag a single giant commit;
    - a protected endpoint with no negative authorization test is a P1 `ask`.
14. **`guard-paths.mjs` parses shell with regexes.** It misses `cd` followed by a relative write, interpreter one-liners, and `;` inside a quoted `sed` script. The Write/Edit rule is the real boundary.
15. **Plugin paths are unresolved.** Prompts and scripts name `verify.mjs`, `run-apps.sh` and `capture-states.mjs` without a plugin root. Also pin the recipe key used for the local checkout's setup command (`setup.setup` here). Post-merge smoke still inherits the developer's shell env.
16. **Prove the untested scripts on a project with its toolchain installed.** `verify.mjs`, `run-apps.sh` and `capture-states.mjs` need a recipe run end to end with `node_modules` and Playwright.
