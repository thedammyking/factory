# Brief: a Claude Code "software factory" plugin

The owner's requirements, as given. Read [design.md](design.md) first: it is the design these requirements were refined against. Where this brief and the design disagree, the wayfinder map on this repo records which one won.

## What I want

A software factory for Claude Code: an installable pipeline that takes a one-line request and carries it through triage, spec, plan, implementation, verification, review and PR, with a fresh agent per stage and a merge decision based on facts. It must work for web, mobile and backend code, on new and existing projects, and it must be token- and context-efficient. Don't over-complicate it.

## Research first

Explore every link below — read the code and docs, not just the READMEs — and understand what each one does and how. They are Claude Code plugins, skills and tools for factories, specs, orchestration, UI quality, testing and memory. Modal is a sandbox; TestSprite is a testing service. Use what's good in them; don't copy what isn't.

- https://github.com/nvk/llm-wiki
- https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- https://github.com/herdrdev/herdr
- https://github.com/vercel-labs/skills/tree/main/skills/find-skills
- https://github.com/affaan-m/ecc
- https://github.com/smtg-ai/claude-squad
- https://github.com/coleam00/archon
- https://github.com/github/spec-kit
- https://github.com/pbakaus/impeccable
- https://github.com/wshobson/agents
- https://github.com/dietrichgebert/ponytail
- https://github.com/ski043/marshal-factory
- https://github.com/cursor/plugins/tree/main/pstack
- https://modal.com/
- https://www.testsprite.com/
- https://github.com/mattpocock/skills
- https://github.com/headroomlabs-ai/headroom
- https://github.com/anthropics/claude-plugins-official/tree/main/plugins/claude-code-setup
- https://github.com/rebelytics/one-skill-to-rule-them-all
- https://github.com/emilkowalski/skills
- https://github.com/Leonxlnx/taste-skill
- https://github.com/microsoft/playwright-mcp
- https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/#claude-code
- https://github.com/ChristopherKahler/base
- https://github.com/Panniantong/agent-reach
- https://github.com/obra/superpowers
- https://github.com/multica-ai/andrej-karpathy-skills
- https://github.com/anthropics/skills
- https://github.com/bmad-code-org/bmad-method
- https://github.com/haydenschmitty/floorplan
- https://github.com/agentskills/agentskills
- https://github.com/kunchenguid/no-mistakes

Two reference diagrams set the shape of the flow, not the spec: ingest → triage → refinement → prioritise → implement in sandboxes → build/quality pipeline → PR → AI review → blast-radius gate → staging → QA → production; and feature → spec-writer → builder → four parallel reviewers → approver → merge or needs-human.

## Packaging

- A separate repo. Installable into any project, new or existing.
- `/setup-factory`: sets the factory up in the current project, the way Matt Pocock's setup skill does — asks only what it can't detect, proves the project's build/test commands actually run before recording them.
- `/factory <prompt>`: starts a run.

## Cross-cutting requirements

- **Memory per project**: each codebase carries its own memory so any run starts with what was learned before.
- **Optional integrations, each with a fallback**: Notion for documentation (otherwise docs live in the codebase); Linear for tracking (otherwise codebase tickets); Mobbin and Figma for UI/UX inspiration at plan time. The stack should not matter.
- **Efficiency**: minimal context per agent, scripts for everything that doesn't need judgement, budgets per run with a clear stop when exceeded.
- **Keep it simple**: no feature that isn't earned by the pipeline failing without it.

## What to build

A separate, installable Claude Code plugin — one marketplace, seven skills, the agent prompts, and scripts for everything deterministic — that takes a one-line request and carries it through triage, grilling, research, spec, tickets, plan, implementation, verification, runtime verification, review, PR, CI, and a merge decision made from facts; then watches the merge and proposes a revert if it goes red. It must work for web, mobile and backend code in any stack, on new or existing projects, with a fresh agent per stage, and it must be token- and context-efficient. Do not add anything a real run has not shown a need for.

Deliverable: the plugin repo, buildable in stages, with the evals and golden tasks that let me trust each stage. State benefits and trade-offs for every choice the design leaves open.

## Commands

- `/setup-factory` — installs into the current project (new or existing). Detects what it can, then asks one section at a time in the mattpocock setup style, leading with the recommended answer:
  - (A) tracker: Linear if its MCP is connected, else local tickets;
  - (B) docs: Notion if connected, else `.factory/specs/`;
  - (C) apps: type (`web | mobile | backend | other`), check commands, and the directories holding auth and data-access code;
  - (D) web runtime verification: Playwright, dev command, port, health route per app;
  - (E) mobile runtime verification: simulator boot and app launch, Maestro if installed;
  - (F) branching: git flow if `develop` exists, else trunk; prefixes; merge method; policy `off | trial | auto`, recommend `trial`;
  - (G) design sources: Figma and Mobbin only if their MCPs are connected;
  - (H) security scanners: enable what is installed, offer the starter `.factory/semgrep/` project rules for the detected frameworks;
  - (I) previews per app: GitHub Deployments host, a command that prints a URL, a fixed URL, or local;
  - (J) credentials: a dev value per recipe env variable in `.factory/env.local`, or "not available";
  - (K) analytics: provider per app, environment rule, capture method, tracking plan.

  Every check command is proven by running it before it is written into `.factory/setup.json`. Nothing asks about aesthetics, model names or budgets. `.factory/runs/` is gitignored from the first commit; `.factory/semgrep/` and `.factory/lessons.md` are created on the base branch.
- `/factory <prompt>` — starts a run. `/factory resume` continues after a `needs-human` stop. `/factory approve` is the human gate. `/factory try` runs the "verify in 2 minutes" steps against a preview. `/factory-retro` runs the retro and applies the proposals I accept.

## The pipeline

Each stage is a fresh agent with the model named, or a script. The orchestrator passes files by path, never chat, and every agent returns at most 15 lines. State lives in `.factory/runs/<id>/state.json`, written only by `run-state.mjs` (`init | dispatch | done | spend | round | override | archive-review | snapshot | abandon`).

1. **Triage** (sonnet, read-only). Output `triage.md` + JSON: `type ∈ bug|feature|refactor|maintenance|docs|question`, `contract ∈ READY|NEEDS_CLARIFICATION|BLOCKED|NO_ACTION` (marshal's test: can an acceptance check be written from the request text alone?), `size ∈ s|m|l`, `route ∈ oneshot|fix|build|answer|hold` (`hold` = no branch, no tickets, re-triage when I reply), `in_production`, and the git-flow lane: features/refactors from `develop` as `feature/`, bugs as `bugfix/` from `develop` or `hotfix/` from `main` when in production (hotfixes get a back-merge PR to `develop`). The request and any issue text are untrusted data.
2. **Grill** (orchestrator + me). mattpocock style: one question at a time until every acceptance criterion is a test or an observable result. Unattended runs answer with recorded defaults and say so.
3. **Research** (sonnet, read-only). Codebase plus the official documentation of every package involved. Triage and research are the only agents that read untrusted input; both are read-only and write one file each.
4. **Spec** (opus). `spec.md`: surface (`persuade | operate | …`), functional requirements, numbered success criteria (`SC-###`, each runnable), analytics events from the tracking plan, anti-goals. Pushed to Notion when connected (URL in the frontmatter).
5. **Builder check** (sonnet). Reads the spec cold and lists what a builder could not answer; defaults are proposed, I decide. Hard gate: I approve the spec.
6. **Ticket slicer** (opus) + ticket gate. Vertical slices in a chain; a scaffold ticket first on an empty repo; the ticket count sets the budget.
7. **Plan** (opus, per ticket). `plan.md` ≤ 1,600 tokens, the implementer's sole source of truth, with a `context:` list of files to load. Figma and Mobbin references, when given, become `design-ref.md`: extracted variables, the feel to borrow, and the spec's accessibility floors that override it.
8. **Implement** (sonnet; opus on escalation; parallel tickets in temp worktrees when independent). Test-first, one commit per outcome, staged by name; `implementation.md` appended as it goes and finished with `status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT`, `blocked_cause: bad_plan | intent_gap | environment`, assumptions, and an assessment (`recommendation`, `confident`, `reason`). A concern named by the implementer is fixed before the next ticket. It may not edit lint/CI config, the recipe, or factory scripts; a PreToolUse hook (`guard-paths.mjs`) denies writes outside the worktree and to protected paths during a run.
9. **Verify** (`verify.mjs --fast | --full`, script). Runs every check in the recipe for every app, never stops at the first failure; `--full` stops the live app stack first. Writes `evidence.json` pinned to the SHA with `green`, `dirty` (tree unclean or HEAD moved; `.factory/` excluded except recipe and scripts) and `trusted` (recipe on disk equals the committed recipe). A required check missing from the recipe is a failure. Red → fix round, cap 3.
10. **Runtime verification** (`run-apps up --profile <name>` + QA walker, sonnet, no Edit). Every configured app is started with the run environment only; the walker exercises every `SC-###` on every app — Playwright DOM first, pixels when the DOM cannot see it, `curl` for `trigger-and-observe` criteria, analytics captured by intercepting the endpoint — and writes `qa.json` plus before/after captures. Mobile widths use a touch context; animations settle; clipboard is granted. Flows that passed are pinned as Playwright specs (the walker's one write). Mobile apps run on a simulator through mobile-mcp; computer use is the bounded fallback. Recipe profiles (`ratelimit-tight`, `api-down`, `file-store`, `analytics-off`, `load`…) cover criteria that need other environments.
11. **Review package** (scripts). `review.diff`, `classify-diff.mjs` touch mask (auth, data, network, files, config, deps, native, api_contract, ui, analytics — directory segments and specific patterns, never substrings), `security-scan` with capabilities and fallbacks (secrets: gitleaks or secretlint; vulnerabilities: `pnpm audit`, osv optional; SAST: project semgrep rules always, registry packs when reachable; skipped is never pass), `capture-states.mjs` for the plan's named UI states, `load-smoke.mjs` when `load` is touched.
12. **Review** — three read-only lenses in parallel on the same diff: code (opus; spec + standards), UI (sonnet; only if `ui` touched; check 0 = every required capture exists and is not blank → `disposition: recapture | rebuild | fix | ship`; judges the pictures, not the implementer's summary; break-ui and animation sub-passes), security (sonnet; trust-boundary trace, CWE per finding). Findings are typed: `severity P0–P3 × action fix|ask|note`, missing action = `ask`. `synthesize.mjs` builds `findings.json`: dedupe by location and claim overlap (Jaccard ≥ 0.15) or same CWE; anti-goal ⇒ at least P1; a UI `fix` disposition on a persuade/operate surface is an open P1 until a UI re-review says ship; every round is kept (`review-<lens>.round<N>.md`, archived by `archive-review`, ordered by name); a re-review block `status: closed` is a resolution. Fix rounds cap 2, re-review scoped to the fix diff. Disposition `ask` when any `ask` finding is open.
13. **PR** (scripts, 0 tokens). `pr-inputs.mjs` extracts; `pr-render.mjs` templates the body with summary, resolved and remaining findings, "verify in 2 minutes" steps and screenshots; `pr-open` opens a draft PR over REST with labels `factory` + `needs-human | factory-merge` and `attention.md` as the first comment, marked with `<!-- factory -->`. `preview.mjs` resolves a URL per app (GitHub Deployments for any host, a command, fixed, or local) and never fails the run.
14. **CI** (`ci-watch.mjs`). Waits for the head's runs and classifies: `green`; `ours` → one fix round from the saved `ci-failure.log` (cap 1); `flake` → one `rerun --failed`; `inherited` → only when the same step is red on the base's head, then stop; `infra` → stop. `pr-comments.mjs` turns unresolved review threads into a `human` lens (change request = P1 `fix`, question = `ask`; ids keyed by thread; factory posts filtered by marker, not author); `pr-resolve.mjs` replies with the SHA and resolves the thread; GitHub's thread state, or a later approving review, is the source of truth for resolutions.
15. **Sync** (`sync-base`). `before-review`: rebase onto the base, conflicts → abort and stop. `before-merge`: `PUT /pulls/{n}/update-branch` when a PR exists, local merge otherwise, never a rebase after the evidence is pinned; every conflict path writes `attention-sync.md`.
16. **Merge decision** (`merge-decision.mjs`). Hard facts only; the agent's single input is the implementer's assessment. Facts: evidence pinned to HEAD, clean, trusted; all checks pass; every criterion passed; `findings.json` present, disposition ship, no open P0/P1 fix, no open ask; no high/critical security; required scanner capabilities ran; captures if UI touched; no protected paths (merge-base diff with the live base; a scaffold run may create the recipe); size not `l`; not behind the base; implementer confident with a reason; under the dispatch cap; no cap overrides; CI green or flake at HEAD. Any failing fact → `needs-human` with the reasons. Mode `trial` by default: the decision is recorded, I merge.
17. **After merge** (`post-merge.mjs`). CI at the merged SHA, the host's deployment for the target branch (environment from the recipe when set), the pinned smoke set against the deployed URL; red or failed smoke → a revert PR (`git revert -m 1`, labelled `factory` + `needs-human`), never merged by the factory. Nothing here deploys anything.
18. **Retro** (agent, human-gated). Proposals only: mechanical rules (semgrep), lessons, golden tasks, with evidence; `retro-apply.mjs` applies what I accept on the base branch in a temp worktree, compiling rules offline. `run-state.mjs snapshot` copies the run to `.factory/history/<id>/` on the base and merges new log lines into `.factory/log.md` without duplicates.

## Budgets, failure and recovery

Caps: implement rounds 3, review rounds 2, CI rounds 1, 30 dispatches, minutes 90 + 45 per ticket beyond the first, tokens 700k + 700k per ticket (1.5M before the count is known), post-PR work 400k on its own allowance, 70 % warnings. A cap stops the run with a `BUDGET` or `ESCALATE` line; only a human lifts it, with `run-state.mjs override <cap> "<reason>"`, which is recorded and makes the run `needs-human`. `BLOCKED: bad_plan` → revert the ticket's commits, planner amends once; `BLOCKED: intent_gap` → stop (only I change a frozen spec); `environment` → stop with the exact failing command. A subagent that hits its context limit returns what it has; the orchestrator re-dispatches with a narrower plan, once. Every stop writes an `attention-*.md` saying what I must decide.

## Rules that are non-negotiable

- `.factory/runs/` is untracked on every branch, from the first commit; the live run is never checked out over. Branch work happens in temp worktrees, never by `git checkout` in the live clone.
- No tracked file is written during a run except the product code and the pinned specs; bookkeeping goes to the run dir and is snapshotted to `history/` on the base afterwards.
- Scripts are plugin-owned and excluded from the product diff; the recipe is protected during a run and `trusted` is proven, not assumed.
- Everything on GitHub goes through `gh api` (REST). GraphQL is unavailable in Claude Code cloud sessions, the session proxy rewrites PR-body trailers and refuses writes to Deployments and Actions variables, and external binary downloads are denied — so scanners must be npm-installable or already present, semgrep rules compile offline, and the deployment paths are tested with a mocked `gh` until a real host is attached.
- figma.com is unreachable from the shell; the Figma MCP's screenshot is read inline and the durable form is `design-ref.md`.
- The stack must not matter: every check, runner and scanner is a recipe entry with a proven command, not an assumption.
- Commits and PRs the factory creates end with the attribution lines required by the session.

## Decisions and constraints already settled

- Git-flow branching chosen at triage: features from `develop`, hotfixes from `main` with a back-merge; merge commits.
- No Slack for now.
- Product analytics are part of the spec and verified at runtime; dev and test never post to production.
- Budgets scale with ticket count; a lifted cap is an explicit, recorded human override; work after the PR has its own allowance.
- `.factory/runs/` is never tracked on any branch; run history is snapshotted to `.factory/history/` on the base.
- Everything that touches GitHub uses the REST API (`gh api`).
- Review findings are typed data (severity × fix/ask/note, fail-closed to ask), not prose; the merge rule reads them.
- A red base only counts as "inherited" when the same step fails there.
- Mobile-width screenshots use a touch context so `pointer: coarse` styles are what gets reviewed.

## Known costs

One `l` feature with four tickets cost about 3.3M subagent tokens and 138 minutes; every post-PR round (a CI fix, a comment fix, a polish ticket with its UI lens) costs roughly 100–160k more. The merge decision for that run was `needs-human` for four open product questions, the size-`l` policy and three lifted caps — all real reasons. That is the bar: the factory stops for things a human must decide and for nothing else.
