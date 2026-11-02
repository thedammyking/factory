# Review of the starting drafts

Checked against `docs/design/design.md` (fixes 1–26) and `docs/design/brief.md` (stages 1–18 and the non-negotiable rules). A second pass closed the gaps the first one listed; see the last three sections. Every script passes `node --check` / `bash -n`. They were run against a copy of the test bed's finished run. GitHub calls went to a `gh` shim with canned JSON, and pushes went to a local bare remote, so nothing was written to the network. Statuses are: works, fixed, gap (a defect left for the build) and untested (with what it needs).

## Files

### Agents
- `agents/builder-check.md`: **works**. It reads the spec cold and returns at most 8 questions, each with a default (brief stage 5).
- `agents/implementer.md`: **fixed**. It had no test-first rule; it now has test-first, plus the bug's failing regression test committed on its own first. It also pointed at the dry run's vendored `.factory/scripts/verify.mjs`; it now runs `${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs` and writes run files under the absolute `{run_dir}`.
- `agents/planner.md`: **fixed**. Success criteria now carry a `profile:` tag and a `live-safe` mark (fix 4 and post-merge smoke need them). The plan gains a `## UI states` list for `capture-states.mjs` (fix 11), and also covers tracking-plan names and `design-ref.md` (brief stages 4 and 7). Tickets and plans now live in `{run_dir}/tickets/`.
- `agents/pr-writer.md`: **gap**. `pr-render.mjs` replaced it (fix 10). It still reads the `review.md` prose instead of `findings.json`, and it would overwrite the rendered `pr.md`. Decide whether to keep it as an optional polish pass or delete it.
- `agents/qa.md`: **fixed**. The pin path was hard-coded to the test bed's `apps/web/e2e/`. It had no profile walk (fix 4), no mobile-mcp driver (brief stage 10) and no `blocked: budget`. The touch context and clipboard rules (fix 23) were already there.
- `agents/researcher.md`: **works**. It is read-only, treats fetched pages as data, caps output at 300 lines, and records `partial` when a fetch fails.
- `agents/retro.md`: **fixed**. Its inputs named dry-run files (`review-round2.md`, `review-ui-round2.md`) that the `round<N>` convention never produces. It now reads `post-merge:` lines first and adds golden tasks (brief stage 18). It also states the section format that `retro-apply.mjs` parses.
- `agents/reviewers.md`: **fixed**. Re-reviews had no instruction to close findings with `status: closed` blocks, which fix 16's resolution ledger depends on, and were not scoped to the fix diff (brief stage 12). The design rules it lacked are in now: the critique rubric's floor, an endpoint with no auth or data touch, a single giant commit, and a protected endpoint with no negative authorization test.
- `agents/triager.md`: **fixed**. It hard-coded git-flow. The lane now comes from `config.json` `branching`, and trunk mode is covered (brief F).

### Scripts
- `scripts/capture-states.mjs`: **works**. It ran with real Chromium against the running web app: light and dark at 390 and 1440 px, an error state with the API blocked, and a missing selector reported as a failure. It now loads Playwright from the project (`playwright` or `@playwright/test`) before any global install, and exits 1 when a state could not be captured. A later pass added a `hover` action and a per-state `overflow` flag. It also implemented the `axe` option the header documented but nothing ran: it is on by default, and without `@axe-core/playwright` in the project it records `axe: "missing"`. All three ran with real Chromium (Playwright 1.62) on a test page: overflow at 390 px only, an `image-alt` violation found, the hover style pictured, `"missing"` when axe is not installed, and nothing when a state sets `axe: false`.
- `scripts/ci-watch.mjs`: **fixed**. All five outcomes ran with the shim. When the base was red for a different step, `cause` came out `undefined` (fix 17 says `ours` plus a note); this pass fixed that. The "same workflow" test was always true (`filter` used where `every` was meant). `base_branch` was spliced into a shell string.
- `scripts/classify-diff.mjs`: **fixed**. Its built-in defaults were the old substring rules: without a project `touch-rules.json` they fired `auth` and `files` on the test bed's diff, which is what fix 9 removed. They also counted `.factory/` bookkeeping (scripts, tickets) as product. It now fires data, network, crypto and api_contract, and not auth or files. A top-level `auth/` now matches as a segment.
- `scripts/guard-paths.mjs`: **fixed**, in both passes. The original passed all twelve fix-5 cases. It failed the rest:
  - a symlinked directory or file let a write escape the worktree;
  - `> ../../x` escapes were not caught;
  - during a run it denied reads and script calls, e.g. `cat .factory/setup.json | grep perform`, or `node ~/.claude/plugins/.../verify.mjs 2>&1`.
  Paths are now realpath-resolved and writes through symlinks are refused. The protected regex checks only write targets, and Write/Edit to `/tmp` is allowed as the design says. The second pass replaced the regexes with a quote-aware tokenizer. It follows `cd` and checks `$(…)`, `bash -c`, inline node/python/perl/ruby writes and `dd of=`. It also allows writes to the run directory in the main checkout, reads `ACTIVE` from there, and does nothing in projects without `.factory/`. `scripts/guard-paths.test.mjs` passes 35/35.
- `scripts/lib.mjs`: **new** in the second pass. It is shared by every script: it finds the product tree and the run (in the main worktree), builds the recipe env from `env.local`, supplies the attribution lines, and provides `commitToBase`. The shell scripts reach it through a small CLI (`run-dir`, `main`, `trailer`).
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
- `scripts/run-apps.mjs`: **works**, rewritten from `run-apps.sh` (which hard-coded the test bed's two apps, `pnpm` and ports, ignored `env.local`, and freed ports Linux-only). It starts every app in `setup.json` with its `preview.local` command, in the recipe env plus profiles. Each app runs in its own process group, so `down` stops the whole tree, then frees each port with `lsof -sTCP:LISTEN`, which matches listeners only and never a connected browser. Proven on the test bed: `default`, `file-store` (`{run}` substitution), `api-down`, an unknown profile, and a `down` that left no listener while an unrelated dev server on another port kept running.
- `scripts/run-state.mjs`: **fixed**. init, dispatch, done, spend, round, override, archive-review, abandon and snapshot all ran on a temp run. Problems found:
  - A repeat snapshot with nothing new crashed and leaked a worktree, so every later snapshot failed (fix 24).
  - A `tokens` override also lifted the post-PR allowance, so the test bed's own state never stopped at 400k (fix 13). It now has its own `post_pr` override.
  - The trailer was hard-coded.
  - `round` produced NaN on states without `rounds.ci`.
  The second pass added `reconcile`, `next-ticket`, `ticket`, `agent` and `approve migrations`. `ACTIVE` is now JSON (id, branch, session, started-at); the 70% minutes warning exists, and every 70% warning fires once; a stale lock is reported. `snapshot` goes through `lib.commitToBase`. `scripts/run-state.test.mjs` covers all of it in 9 tests.
- `scripts/security-scan.mjs`: **works**, ported from `security-scan.sh` (whose first-pass defects were invalid JSON on macOS, `apps` pathspecs, no `timeout` on macOS and a path spliced into `node -e`). It ran with real gitleaks 8.30, semgrep 1.183, osv-scanner 2.7 and pnpm audit. Non-JS stacks use osv-scanner, or else get `missing`. High and critical items from every tool fill `findings`. The real semgrep run exposed a data-loss bug, now fixed; see "What running the real tools found".
- `scripts/sync-base.sh`: **fixed**. Every path ran: rebase, rebase conflict, local merge conflict, update-branch accepted and update-branch refused. Each conflict aborted and wrote `attention-sync.md` with the branch untouched (fix 22). Defects found:
  - With `ACTIVE` missing, its restore trap would `rm -rf .factory/runs/`.
  - After update-branch's async 202 it claimed "merged" before the merge arrived.
  - It found the project from the script's own location (run from the plugin, it acted on the wrong repo).
  - It spliced a path into `node -e` and took the base branch unchecked (`--exec=` option injection into `git rebase`).
- `scripts/synthesize.mjs`: **fixed**. The fix 3 groups and 12 resolutions (fix 16) reproduce exactly. The UI rule (fix 6) was broken: a `ui-disposition` resolution from round 2 closed the round-3 lens's `disposition: fix`, which no UI re-review ever approved. On the test bed's data it now shows as an open P1. `rebuild` and `recapture` count as not-ship.
- `scripts/verify.mjs`: **works**. `--full` ran the test bed's real recipe (typecheck, unit tests and Playwright e2e for two apps): green, clean and trusted. First-pass fixes, checked with a stub recipe:
  - `{base}` was spliced into `bash -lc`; a base of `$(touch …)` ran.
  - Checks inherited the developer's shell and login profile instead of `.factory/env.local` only.
  - The fix 15 `run-apps.sh down` only ran when scripts were vendored into the project.
  The dirty, trusted and missing-check behaviour holds.

### Skills
- `skills/ui-craft/SKILL.md`: **new**. It is the craft floor that design.md gives the `ui-craft` skill, plus the rules taken from ai-design-skills (see below). It also sets the order of authority (floor, then the project's design tokens, then `design-ref.md`, then any other design skill). The implementer loads it when a plan has `## UI states`. Untested: no run has used it yet.

### Config
- `config.json`: **works**. Caps match the brief (3/2/1 rounds, 30 dispatches, 90 + 45 min, 700k + 700k tokens) and the merge policy is `trial`. `merge_limits.max_files` (40) sets the blast-radius limit. It has no `qa.drivers.mobile` entry, so the mobile driver is implied.
- `touch-rules.json`: **works**. Fix 9's re-classification holds with it. A new `migrations` category feeds the merge rule.

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
- Second pass: semgrep's baseline mode no longer runs in the live checkout (it deleted run files), and `guard-paths` follows `cd`, subshells and inline scripts.

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
- **Exercised in the second pass:** 4 (profiles with the apps running), 8 (the real scanners), 11 and 23 (captures with real Chromium; the touch contexts and settled animations ran, but the coarse-pointer rendering was not measured).

## The first pass's gaps, closed
1. **Run directory inside temp worktrees.** `lib.mjs` finds the run in the main worktree (`git rev-parse --git-common-dir`), and every script and the guard use it. Agents get an absolute `{run_dir}`. `verify`, `run-apps` and the post-merge smoke read `env.local` from the main checkout. Tested from a linked worktree.
2. **Base branch checked out elsewhere.** `lib.commitToBase` commits in a detached temp worktree, then fast-forwards the worktree that has the branch checked out, or else moves the ref with a compare-and-swap. `snapshot` and `retro-apply` use it. Tested with the base checked out elsewhere and checked out nowhere.
3. **Attribution lines.** Env vars do not survive between Bash calls, so the orchestrator records the lines once, with `run-state.mjs set attribution '{"commit":"…","pr":"…"}'`. `lib.trailer` takes an export first, then the recorded lines, and refuses when neither exists. The orchestrator skill must make that call right after `init`; see "Still open".
4. **`run-apps.sh`.** Rewritten as `run-apps.mjs`; see Files.
5. **Review-thread resolution.** Decided: GraphQL first, which works in local sessions; the cloud proxy's `ccr/` routes second; flat comments as a fail-closed last resort. Both paths ran against the `gh` stand-in.
6. **Tickets and plans.** Decided in [Where do a run's local tickets live?](https://github.com/thedammyking/factory/issues/23): they live in `{run_dir}/tickets/` and are snapshotted to `history/`.
7. **`run-state.mjs`.** See Files.
8. **Merge facts.** Five new facts:
   - `pr_targets_run_base`: the live PR, read over REST, has the run's base and the evaluated head.
   - `no_merge_conflict`: `git merge-tree`, plus GitHub's `mergeable`.
   - `previews_ready_for_touched_apps`.
   - `blast_radius_under_limit`.
   - `no_migrations_unless_approved`: a maintenance run plus `run-state.mjs approve migrations`, which is not an override.
   `security.json` now has `findings`, so `no_high_security` checks something real. Each fact was shown failing and passing on the test bed.
9. **Preview status.** Every entry has `status: ready | failed | timeout | none`. A failed deployment returns at once: 0.1 s against a 600 s wait.
10. **Security scan for other stacks.** osv-scanner covers non-JS lockfiles. On a Python project it found 23 high/critical advisories, and a token was caught by both gitleaks and the secretlint fallback. `retro-apply`'s offline semgrep compile is proven too: a broken rule exits 1 and moves nothing.
11. **Human-lens nits.** Decided: every unresolved collaborator thread is a P1 `fix`, nits included. Resolving the thread waives it.
12. **Oneshot verify steps.** With no spec, the verify step is triage's `acceptance_check`. Steps open the ready preview URL, or else the local app served at `/`. The preview list prints as URLs with their status.
13. **`reviewers.md` rules.** All four added; see Files.
14. **`guard-paths.mjs` parsing.** Closed for the forms in Files. Variables, globs, heredoc bodies and `xargs` remain out of reach, so the real boundary for Bash is an OS sandbox. That choice belongs to [How are parallel tickets and E2E runs isolated?](https://github.com/thedammyking/factory/issues/12).
15. **Plugin paths.** Closed in the drafts:
    - Agent prompts name `${CLAUDE_PLUGIN_ROOT}/scripts/…`, which is substituted when a plugin agent loads.
    - Scripts find their siblings in their own directory.
    - The install command is pinned as the recipe's `setup` key, and `pr-inputs` says so when it is missing.
    - The post-merge smoke runs in the recipe env. Proven: a variable from the developer's shell did not reach it.
    The project's `verify` skill is not part of this; see "Still open".
16. **Untested scripts.** `verify`, `run-apps` and `capture-states` ran end to end with `node_modules`, Playwright and Chromium.

## What running the real tools found
- **Semgrep's baseline mode deleted live run files.** `--baseline-commit` resets the scanned tree to the base commit and back. In the live checkout that deleted `ACTIVE` and `state.json`, which the base commit had once tracked, and it moved HEAD while dev servers were running. Any ignored file the base once tracked, such as a local `.env`, is at the same risk. The first pass's `security-scan.sh` had the same flaw. Fixed: semgrep now scans a detached temp worktree.
- **Corepack's auto-pin dirties the tree.** pnpm run through corepack adds `packageManager` to `package.json` on every call, so verify could never be green. `COREPACK_ENABLE_AUTO_PIN=0` in `.factory/env.local` fixes it. `/setup-factory` should set it when it finds a corepack shim, or offer to commit the pin, and prove the recipe leaves the tree clean.
- **Registry packs blocked merges on warnings.** Any finding failed the capability, so a merge would wait on warnings about CI action tags. Now only ERROR hits fail; the warnings stay in `semgrep-packs.json` for the security lens.
- **Semgrep scanned `.factory/`.** Vendored factory scripts tripped the project rules. `.factory/` is now excluded, as in every other product-diff step.
- **Verify's environment holds only `env.local`.** A non-default `PLAYWRIGHT_BROWSERS_PATH`, or any other toolchain variable, must go there. The default browser cache needs nothing.
- **`guard-paths` used to confine writes in every project.** It is a plugin-level hook, so it runs in every session. It now does nothing in projects without `.factory/`.

## Taken from elayadesign/ai-design-skills
[ai-design-skills](https://github.com/elayadesign/ai-design-skills) has two skills, `landing-page-design` and `figma-designer`. Only the measurable, stack-neutral rules were taken:
- **Content honesty.** No invented prices, counts, statistics, testimonials or logos; a missing fact is a visible `{{placeholder}}`. Errors say what failed and what to do next. It is in `ui-craft`, in the spec's new `## Offer` section, and in the UI lens as a `P1 fix`.
- **States.** Every interactive element has hover, active, focus and disabled styles; data views have loading, empty and error states; no `href="#"`; the nav marks the current page. The plan's `## UI states` list gains hover and disabled.
- **Motion.** Animate only `transform` and `opacity`, add a `prefers-reduced-motion` fallback, and use `IntersectionObserver` for scroll effects. The factory's ≤ 300 ms ease-out stays; the source's 500 ms does not.
- **390 px check.** No horizontal overflow, and the primary action is in the first screen. `capture-states.mjs` records `overflow`.
- **Smaller floors.** The nested radius rule, state never shown by color alone, and gradient text checked at its lightest end.
- **Persuade intake.** On `surface: persuade` the spec gains `## Offer`: primary action, offer, audience, top three objections, traffic source and the proof that exists. The builder check asks about any item that is missing or a placeholder.

Left out: the house style (font allow and deny lists, no italics, no hyphens, gradient hero text, fixed dark colors, icon libraries, the mandatory tagline section) and the Figma write workflow. The factory takes the look from the project, never from a skill. `landing-page-design` should not be installed next to the factory: its description claims all web UI, so an implementer would load it over the project's design tokens. `ui-craft` says the project wins, but the clash is better avoided.

## UI references: proven patterns first
The owner's rule: a UI ticket follows patterns that already work in shipped products before anything is designed from nothing. Whatever the source, a component library the codebase already has comes first. The researcher names it before anything else (step 0). `design-ref.md` maps each element to one of its components and names any new component. `ui-craft` matches a Figma or Mobbin design through the components' variants, props and theme tokens. The code lens makes a hand-built duplicate of a library component a `P1 fix`, so it goes back through the fix loop instead of reaching the PR as a note.

The order is:
1. A Figma URL in the request, when the Figma MCP is connected (`ui.figma`). A URL without the MCP is recorded as `partial: figma unavailable`, because figma.com cannot be read from the shell.
2. Else Mobbin, when `ui.mobbin` is true, for the structure.
3. The existing UI's design language, whenever there is no Figma design: the similar screens, where the tokens live, the components to reuse and the layout habits they share. With Mobbin picks it gives the look and the components; without them it is the whole reference.
4. With no UI and no component library in the repo yet, a new component library supplies the look and components: HeroUI (HeroUI React for web, HeroUI Native for mobile) when an app is mobile or a component must exist on both, shadcn/ui for web only. The layout comes from the Mobbin picks, or else the library's examples and blocks. The first UI ticket installs the library. The choice follows the platform, so setup still asks nothing about aesthetics. A stack neither library serves (not React or React Native) gets "no proven reference".
- **The researcher searches Mobbin, not the planner or the orchestrator.** design.md says the orchestrator calls Mobbin in short steps. That would put untrusted text in the session that acts, against its own trust-boundary rule that only the triager and researcher read untrusted input. The researcher (half C) makes at most six searches and records 2–4 picks in `research.md`'s `## UI references`. A pick is the app, the screen or flow, its link, what to borrow (layout, hierarchy, primary action, states) and what not to (the other product's brand, copy and illustrations). A pattern several apps share beats a one-off.
- **The planner** writes `design-ref.md` for every UI ticket from that section, so a Mobbin pick reaches the implementer as factory-written text. The planner lists it in `context:`.
- **`ui-craft`** follows the reference's structure, reuses the project's components before writing new ones, and composes new layout only for what the reference does not show, from the project's existing screens first. The project's design tokens still set the look, so a pick lends its structure and never its skin.
- **The UI lens** classifies each element against `design-ref.md` and the spec.
- `config.json` gains `ui.figma` and `ui.mobbin`, both `false` until `/setup-factory` section (G) finds the MCP connected.

Skipped: downloading the picked images. Mobbin's image URLs expire after 30 days and the picks are other companies' copyrighted UI, so the run keeps the links and the written pattern. Add a download step if a reviewer needs the pictures. Untested: no Mobbin MCP was connected here. The tool names come from design.md (`search_screens`, `search_flows`, `search_sections`), and their prefix depends on the server's name in `.mcp.json`.

## Still open
- **`/setup-factory` (not drafted)** should offer `@axe-core/playwright` when it finds Playwright, or every capture records `axe: "missing"`. Section (G) sets `ui.figma` and `ui.mobbin` from `claude mcp list`.
- **The orchestrator skill (not drafted) has three jobs:**
  - Record the attribution lines right after `init` (gap 3).
  - On `surface: persuade`, put the `## Offer` items to the human during the grill, one question at a time.
  - Keep the project's `verify` skill pointing at the plugin (gap 15). That skill is a project skill, so `${CLAUDE_PLUGIN_ROOT}` is not substituted in it, and `CLAUDE_ENV_FILE` is not documented to reach subagents. Recommended: the SessionStart hook keeps a launcher at `${CLAUDE_PLUGIN_DATA}/bin/factory`, a path that survives plugin updates, and the skill calls that launcher.
- **Per-run ports and databases.** `run-apps.mjs` uses the recipe's fixed ports, so two runs on one machine collide. That belongs to [How are parallel tickets and E2E runs isolated?](https://github.com/thedammyking/factory/issues/12).
- **`agents/pr-writer.md`** stays until [What exactly does the plugin ship?](https://github.com/thedammyking/factory/issues/21) decides whether it ships.
