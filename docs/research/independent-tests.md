# How TestSprite writes independent tests, and the native equivalent

Ticket [#9](https://github.com/thedammyking/factory/issues/9), slug `independent-tests`, researched 2026-11-02. Versions read: TestSprite MCP 0.0.48 ([npm](https://www.npmjs.com/package/@testsprite/testsprite-mcp), modified 2026-10-31), Playwright 1.64.1 ([release](https://github.com/microsoft/playwright/releases/tag/v1.64.1), 2026-10-14), no-mistakes v1.106.1 ([release](https://github.com/kunchenguid/no-mistakes/releases/tag/v1.106.1), 2026-10-31). The MCP bundle was read as static text from [jsDelivr](https://cdn.jsdelivr.net/npm/@testsprite/testsprite-mcp@0.0.48/dist/index.js), never executed. Background: [design.md, Testing and sandboxes](../design/design.md#testing-and-sandboxes).

## Answer

- TestSprite's tests are written by its own backend, not by the coding agent, and run by a separate cloud browser. The inputs are not independent: in the MCP flow your IDE assistant writes `code_summary.yaml`, which TestSprite embeds in the "normalized PRD" the plan comes from; in the Portal flow the plan comes from exploring the running app, so expectations track what the app does. Its docs never claim independence.
- Playwright's planner, generator and healer give the same plan, test, heal shape in TypeScript, inside the repo, with no per-run fee. Independence is not a property of those agents: the planner explores the live app (and can read source under the Claude loop), the generator confirms assertions against the live app, and the healer is allowed to edit assertions.
- Independence has to be built from what Claude Code gives a plugin: a fresh subagent with its own context, a plugin-level `PreToolUse` hook that sees `agent_type`, and ordering (write and commit the expectations before observing the app).
- Recommendation: keep TestSprite at v3 as an optional second opinion; add a "plan before observe" rule and a write guard on pinned tests; use the generator for binding locators; do not adopt the healer unrestricted.

## TestSprite's flow

TestSprite has three surfaces over one backend: Web Portal, MCP server and CLI ([CLI overview](https://docs.testsprite.com/cli/getting-started/overview.md)). The design catalogue describes the MCP surface, so that comes first.

### MCP: PRD and code to plan to tests to cloud run to fixes

The documented chain is bootstrap, read the user PRD, code summary, standardized PRD, frontend or backend test plan, generate and execute, results, "IDE fixes issues", rerun ([tools reference](https://docs.testsprite.com/mcp/core/tools.md); [walkthrough](https://docs.testsprite.com/mcp/core/create-tests-new-project.md)). The package source shows who does each step ([`dist/index.js`](https://cdn.jsdelivr.net/npm/@testsprite/testsprite-mcp@0.0.48/dist/index.js)).

| Step (tool) | Who does the work | Output |
|---|---|---|
| `testsprite_bootstrap` | Local MCP: detects frontend or backend, checks the port, sets scope `codebase` or `diff`, opens a config portal where the PRD and test login are supplied ([tools](https://docs.testsprite.com/mcp/core/tools.md)). | `testsprite_tests/tmp/config.json`, PRD files in `tmp/prd_files` |
| `testsprite_generate_code_summary` | **Your IDE assistant.** The tool returns a prompt ("As the AI assistant, you must generate a code summary IMMEDIATELY") and the assistant writes YAML: tech stack, routes, features with `user_interactions` and `api_calls`, `known_limitations` (bundle, code-summary prompt). | `tmp/code_summary.yaml` (docs say `code_summary.json`) |
| `testsprite_generate_standardized_prd` | TestSprite backend: `generateStandardPRD(prdFiles, codeSummary, type)`. The code summary is copied into the result (bundle, `generateStandardPRD`). The docs call this a format TestSprite "invented" ([key terms](https://docs.testsprite.com/mcp/concepts/key-terms.md)). | `standard_prd.json` |
| `testsprite_generate_frontend_test_plan` or `..._backend_...` | Backend: `generateFrontendTestPlan(standardPRD, scope)`. Cases `TC001...` with typed `action` and `assertion` steps, category and priority ([walkthrough](https://docs.testsprite.com/mcp/core/create-tests-new-project.md)). | `testsprite_frontend_test_plan.json` (docs: `frontend_test_plan.json`) |
| `testsprite_generate_code_and_execute` | Backend generates Python + Playwright per case and runs it in a cloud sandbox against your local app through a tunnel. Frontend runs are capped at 15 cases against a dev server and 30 against a production build (bundle, `MAX_DEV_MODE_TESTS`, `MAX_PROD_MODE_TESTS`). | `testsprite_tests/TC00N_*.py`, `tmp/test_results.json` |
| Report | **IDE assistant** completes a report from `raw_report.md` ("identifying what functionality needs fixing"). | `testsprite-mcp-test-report.md` and `.html` |
| Fix | You ask the IDE assistant; "TestSprite provides the analysis and recommendations, while your IDE's AI assistant implements the actual fixes" ([walkthrough](https://docs.testsprite.com/mcp/core/create-tests-new-project.md)). Rerun to verify. | Code edits |

Where independence holds: the plan and the test code are written by TestSprite's backend (closed; the package is [BUSL-1.1](https://cdn.jsdelivr.net/npm/@testsprite/testsprite-mcp@0.0.48/package.json)), a different model and context from the coding agent, and a different process executes them.

Where it does not:
- The code summary, which feeds the PRD, is written by the coding agent. The FAQ confirms "code analysis happens locally (MCP Server)" ([FAQ](https://docs.testsprite.com/learn/faq.md)).
- With no user PRD, the only product description is that summary. The docs' own advice is "update README with clear project description" ([walkthrough](https://docs.testsprite.com/mcp/core/create-tests-new-project.md)).
- The same assistant that wrote the code applies the fixes and chooses what to change. I found no instruction in the package's report prompt telling it not to edit tests.
- TestSprite classifies failures as Product Bug, Test Fragility, Environment Issue or Contract Violation, and applies "safe" healing automatically ([healing](https://docs.testsprite.com/mcp/concepts/healing-observability.md)). That is its own judgement on whether the test or the product is wrong.

The design's quoted rationale ("the agent tests its own assumptions") is not in TestSprite's current docs. I searched the pages listed in [llms.txt](https://docs.testsprite.com/llms.txt) for "independent", "assumption" and "bias" and found nothing relevant; the page the design cites, `docs.testsprite.com/mcp/workflow`, returns 404 on 2026-11-02.

### Portal: plan from the live app

The Portal path does not use a code summary. A testing agent explores the live app "feature by feature" (about 3 minutes), and the plan is "grounded in how your app actually behaves, not just how your PRD describes it" ([exploration](https://docs.testsprite.com/web-portal/core/ui/feature-exploration.md)). A PRD "shapes the plan but doesn't override exploration"; features exploration cannot reach fall back to best-effort spec-based cases ([plan generation](https://docs.testsprite.com/web-portal/core/ui/ui-plan-gen.md)). That is independent of the source and of the implementer's chat, but it records the app's behaviour as the expectation: a bug the app already has is a flow the agent "saw work". This is my inference from those two quotes; TestSprite documents no check against it.

### CLI: the caller writes the test

In the CLI loop the coding agent authors the frontend test as a JSON plan of `planSteps` (`--plan-from`) and TestSprite's cloud browser agent executes it ([creating tests](https://docs.testsprite.com/cli/core/creating-tests.md); [agent loop](https://docs.testsprite.com/cli/concepts/the-agent-loop.md)). The `testsprite-onboard` skill has the agent read the code and write "about 8-15 tests" ([quickstart](https://docs.testsprite.com/cli/getting-started/quickstart.md)). Authoring independence is zero here; what you buy is an external executor and a failure bundle (failing step, DOM snapshots, root-cause hypothesis) ([key terms](https://docs.testsprite.com/cli/concepts/key-terms.md)).

### Localhost, speed, cost, heal

- **Localhost.** Documented, contrary to the design. The MCP tool description says it "tunnels your local server"; the package README documents the tunnel's control and data planes ([README](https://cdn.jsdelivr.net/npm/@testsprite/testsprite-mcp@0.0.48/README.md)); the CLI opens one automatically for `http://localhost:<port>` and caps live bindings at 5 ([local apps](https://docs.testsprite.com/cli/core/local-apps.md)). CLI local runs are frontend only, use the agent path rather than saved-code replay, and do not save the test's code. Vite in dev mode can take "a minute or more per page"; the docs advise a production build.
- **Speed.** Exploration about 3 minutes; a 20-test plan "typically" generates in 1-3 minutes; a UI test takes "5-30 seconds" ([test generation](https://docs.testsprite.com/web-portal/core/ui/ui-test-gen.md)); the FAQ says "most tests complete within 10-20 minutes" end to end ([FAQ](https://docs.testsprite.com/learn/faq.md)). CLI run timeout defaults to 600 s, 1200 s through a tunnel ([local apps](https://docs.testsprite.com/cli/core/local-apps.md)). No independent measurements found.
- **Cost.** Free 150 credits/month; Starter $0 first month then $19 (400); Standard $39 (800); Pro $69 (1,600); Enterprise from $199 (5,000+) ([pricing](https://www.testsprite.com/pricing)). The pricing page does not define a credit. The CLI docs say a run "charges credits" and "a rerun is billed the same as a fresh run" with no replay discount ([rerun](https://docs.testsprite.com/cli/core/rerun-and-auto-heal.md)). Cost-control advice is `testScope: "diff"` and `testIds` subsets ([cost](https://docs.testsprite.com/mcp/maintenance/cost-performance.md)). Add the IDE tokens spent on the code summary and report.
- **Heal.** CLI frontend reruns auto-heal by default and save the repaired version; `--no-auto-heal` replays the saved script verbatim, recommended for a strict regression gate ([rerun](https://docs.testsprite.com/cli/core/rerun-and-auto-heal.md)). TestSprite itself says Auto-Heal "can't tell intentional removal from a regression" ([auto-heal](https://docs.testsprite.com/web-portal/core/ui/auto-heal.md)).

## Native options compared

| | **A. Playwright planner, generator, healer** | **B. Spec-only test writer (custom subagent)** | **C. no-mistakes Test step** (reference) |
|---|---|---|---|
| Who sets expectations | Planner: explores the running app; PRD is optional ([docs](https://playwright.dev/docs/test-agents)). Generator checks assertions live. | A fresh subagent reading only the approved spec (`SC-###`) and plan interfaces, before the implementation exists. | An evidence agent derives scenarios "from user intent and the change" ([Test](https://github.com/kunchenguid/no-mistakes/blob/main/docs/src/content/docs/reference/pipeline-steps.md#test)). Intent is the author's, or inferred from the author's own agent transcripts ([Intent](https://github.com/kunchenguid/no-mistakes/blob/main/docs/src/content/docs/reference/pipeline-steps.md#intent)). |
| Independent of the implementer | Different context and role only if invoked as separate subagents. Not enforced: under the Claude loop `search` becomes `Glob, Grep, Read, LS` ([generateAgents.ts](https://github.com/microsoft/playwright/blob/v1.64.1/packages/playwright/src/agents/generateAgents.ts)), and the planner prompt never forbids reading source ([planner](https://github.com/microsoft/playwright/blob/v1.64.1/packages/playwright/src/agents/playwright-test-planner.agent.md)). | Strongest: cannot see code that does not exist yet; can be enforced by tool allowlist plus hook. | Weak for assumptions (shares the author's intent); strong on "was it really run" (next row). |
| Avoids testing own assumptions | Only partly: expectations come from observed behaviour. The healer may rewrite assertions ([healer](https://github.com/microsoft/playwright/blob/v1.64.1/packages/playwright/src/agents/playwright-test-healer.agent.md)). | Yes, if the spec is precise; it also exposes spec ambiguity early. | Rule: pass or fail needs `live: true` plus evidence; "unit tests, stubs, mocks, recorded fixtures, and code inspection are not live". |
| Cost | No per-run fee. Tokens on your own model; the definitions pin `model: sonnet`. No first-party token figures published. | Tokens only. Claude Code: subagent cost "is mostly tokens" ([best practices](https://code.claude.com/docs/en/best-practices)). | Tokens only. Default auto-fix limit 3. |
| Speed | Planner and generator drive a real browser step by step through an LLM, so minutes per scenario (inference; no figure published). The generated `.spec.ts` then runs at plain Playwright speed with no LLM. | One LLM pass, no browser. Docs warn a fresh subagent "can end up slower" because it must gather context ([best practices](https://code.claude.com/docs/en/best-practices)). | Bounded by `test_agent_timeout`, a per-turn stall budget. |
| Output | `specs/*.md` plan with steps and expected results; `tests/*.spec.ts`; `seed.spec.ts` ([docs](https://playwright.dev/docs/test-agents)); `init-agents --loop=claude` writes `.claude/agents/*.md` and `.mcp.json` ([generateAgents.ts](https://github.com/microsoft/playwright/blob/v1.64.1/packages/playwright/src/agents/generateAgents.ts)). | Whatever the factory specifies: `tests/e2e/<ticket>.spec.ts`, red before implement. | Not a test suite. Structured verdict (`go`, `no-go`, `inconclusive`, `no-surface`) plus scenario records and artifacts; new test files are only "informational `no-op` findings". |
| Pinning | Commit `specs/` and `tests/`; they are ordinary TS. The healer edits them in place, so pinning needs a write guard. | Commit before implement, record the SHA, deny the implementer write access (guard below). | Evidence is stored outside the worktree by default, so nothing enters the branch. |

### A. Playwright test agents

- **Planner** inputs: a request, a seed test and an optional PRD; output is `specs/*.md` ([docs](https://playwright.dev/docs/test-agents)). Its tools are `browser_*` plus `planner_setup_page` and `planner_save_plan`; scenarios assume "blank/fresh state" and must be "independent and can be run in any order" ([planner](https://github.com/microsoft/playwright/blob/v1.64.1/packages/playwright/src/agents/playwright-test-planner.agent.md)). That independence is between scenarios, not between author and implementer.
- **Generator** runs each plan step through browser tools, has `browser_verify_*` assertion tools, reads its log (`generator_read_log`) and writes one test per file (`generator_write_test`), with a comment per step. It has no `Edit` ([generator](https://github.com/microsoft/playwright/blob/v1.64.1/packages/playwright/src/agents/playwright-test-generator.agent.md)). The docs say it "verifies selectors and assertions live" ([docs](https://playwright.dev/docs/test-agents)). Inference: if the implementation is wrong, a live check can bless the wrong value unless the plan's expected result is treated as authoritative.
- **Healer** runs `test_run` and `test_debug`, has `edit`, and its remediation list includes "Fixing assertions and expected values". It may mark a test `test.fixme()` when confident the test is right, and is told "do the most reasonable thing possible to pass the test" ([healer](https://github.com/microsoft/playwright/blob/v1.64.1/packages/playwright/src/agents/playwright-test-healer.agent.md)). Unrestricted, it can erase the independence that took effort to build.
- The docs describe running the agents "independently, sequentially, or as the chained calls" and give no cost or speed numbers ([docs](https://playwright.dev/docs/test-agents)).

### B. Spec-only writer: what Claude Code supports

No upstream doc names this pattern; these are the platform facts it can be built from.
- A subagent "runs in its own context window" and receives only its system prompt plus environment details, not the parent conversation ([sub-agents](https://code.claude.com/docs/en/sub-agents)). Best practices call this "a reviewer that hasn't seen how the code was written" and say a `tools` allowlist is "enforced by Claude Code rather than requested in a prompt" ([best practices](https://code.claude.com/docs/en/best-practices)). They also warn it is the same model, so "a fresh pair of eyes, but not a smarter answer".
- `tools` limits tool types, not paths. Path limits need a hook. Plugin subagents ignore frontmatter `hooks`, `mcpServers` and `permissionMode`, but hooks in the plugin's `hooks/hooks.json` apply inside subagents ([sub-agents](https://code.claude.com/docs/en/sub-agents)), and hook input carries `agent_type` ([hooks](https://code.claude.com/docs/en/hooks.md)). So a plugin hook can say "if `agent_type` is the test writer, deny `Read` outside `.factory/specs/` and `tests/`".
- `isolation: worktree` branches from the default branch, not the parent's `HEAD` ([sub-agents](https://code.claude.com/docs/en/sub-agents)), so it does not hide the implementation by itself. Ordering does: before the implement stage there is no implementation to see.

### C. no-mistakes Test step

It does not write tests. The evidence agent stands up the real product, drives each scenario end to end and records `name`, `result`, `live`, `evidence`, `reason`; an existing test counts only if it "drives the scenario end to end", and the agent "must not run the complete repository suite" ([Test](https://github.com/kunchenguid/no-mistakes/blob/main/docs/src/content/docs/reference/pipeline-steps.md)). Its repair prompts allow changing tests or product code but prohibit "tuning product logic or prompts to a scenario's literal wording". The part worth borrowing is the evidence contract (a `live` flag, evidence required for every pass or fail), which goes beyond the finding model the design already borrows.

## Implications for the factory

The design already has the right skeleton: `qa` is a fresh, read-only subagent that walks the spec's `SC-###` list, and passing flows are pinned as Playwright specs generated from the walk ([design.md, Runtime verification](../design/design.md#runtime-verification-run-every-app-walk-every-criterion)). The gap is that the pinned script's assertions come from what the walk observed. The findings above point to the adjustments below.

**Keep**
1. **TestSprite at v3, optional, web only.** Its independence is partial (code summary written by the coding agent, or expectations taken from observed behaviour), its output is Python, a credit is undefined, MCP runs are capped at 15 or 30 cases, and local runs need a production build to be quick. If used, feed it the approved `spec.md` as the PRD, use `diff` scope against a production build, run CLI reruns with `--no-auto-heal`, and treat its failures as findings, never as edit instructions.
2. **`qa` fresh and without `Edit`/`Write`, and the rule that the producer of evidence does not grade it.** Best practices describe the same benefit; the cost is tokens plus context gathering.
3. **Playwright's generator for pinning.** Same TS toolchain, no fee, and it has no `Edit` tool.

**Change**
4. **Plan before observe.** Have `qa` write `specs/<ticket>.md` (steps plus expected results copied from the `SC-###` text, in Playwright's plan format) before it touches the app, commit it, then walk, then let the generator bind locators. A failed assertion is a finding, never a rewrite. Benefit: expectations cannot be fitted to the implementation, which is the actual defence against "the agent tests its own assumptions". Trade-off: criteria must be precise enough to script; visual or layout criteria (the design's vision path) stay unscripted and are never pinned.
5. **Write guard on pinned tests.** Extend the existing `PreToolUse Edit|Write` hook (`guard-config.mjs`) to deny the `implementer` agent writes to `specs/**` and `tests/e2e/**` once pinned. Benefit: "tests the implementer didn't write" is enforced, not requested. Trade-off: a wrong test now needs an escalation path (an orchestrator or user decision) instead of a quiet fix by the implementer, which fits the three-round cap.

**Do not adopt as is**
6. **The healer.** A failing pinned script is a regression signal; healing it removes the signal, and TestSprite's docs admit the same limit. If the factory wants locator healing, restrict it with the same hook (reject edits touching `expect(` or `test.fixme`) and surface every heal as a diff for review. The lazy default for v1 is no healer: failure goes back to the implementer.

**Optional later (v2 candidate)**
7. **A spec-and-plan-only test author before implement**, for backend criteria and `trigger-and-observe`, where no browser is needed. It sees interface names from the plan but no implementation. Benefit: the cheapest real independence (tokens only) and early spec-ambiguity detection. Trade-offs: tests are red until the implementer lands matching names, a bad interface guess is a test-side failure, and the implementer's own unit tests remain non-independent, which no option here changes.

### Corrections to design.md's TestSprite row
- The cited `docs.testsprite.com/mcp/workflow` page returns 404; the walkthrough is [create-tests-new-project](https://docs.testsprite.com/mcp/core/create-tests-new-project.md).
- "How it reaches `localhost` is undocumented" is outdated: a tunnel is documented ([README](https://cdn.jsdelivr.net/npm/@testsprite/testsprite-mcp@0.0.48/README.md); [local apps](https://docs.testsprite.com/cli/core/local-apps.md)).
- Pricing has four paid tiers, not only Pro $69 ([pricing](https://www.testsprite.com/pricing)); "a credit is never defined" still holds there.
- Add the 15 and 30 test caps and the CLI surface (auto-heal on by default, a tunnel, no code saved for local runs).

## Not verified

- TestSprite's server-side prompts and models are closed, so how its backend uses the code summary beyond what the client sends is unknown. No first-party quality or independence benchmark exists for TestSprite or Playwright's agents; the one hands-on report the design cites is third-party.
- No first-party token or time figures for Playwright's agents. The "minutes per scenario" estimate above is inference.
- Whether the Playwright planner reads source in practice was not tested; only its tool list and prompt were read.
