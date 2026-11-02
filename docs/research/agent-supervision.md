# How does herdr supervise agents, and what does Claude Code offer natively?

Ticket: [#6](https://github.com/thedammyking/factory/issues/6), slug `agent-supervision`. Researched 2026-11-02 against herdr v0.9.5 (released 2026-10-14) and Claude Code v2.1.316 (2026-10-31, [changelog][cc-log]). Everything below comes from docs and source; nothing was run, so every "would work" is a documented behaviour, not a tested one.

## Answer

- herdr supervises by owning each agent's pseudo-terminal in a long-lived server and reading the screen. It decides `working | blocked | done | idle | unknown` for Claude Code from screen-regex manifests, not from hooks, then offers waits, reads and prompts over a socket, and creates git worktrees as workspaces ([agents][h-agents], [Claude manifest][h-claude]).
- Claude Code now does each of those jobs natively for its own sessions. `claude --bg` starts a supervised session in its own worktree, `claude agents --json --all` reports a structured `state` (`working | blocked | done | failed | stopped`) with a `waitingFor` reason, and `attach`, `logs`, `stop`, `respawn` and `--resume` cover the rest ([agent view][cc-av-shell]). `claude -p --output-format stream-json` and hooks cover child-process runs and push signals.
- The combination that drives and watches long or parallel runs without herdr: `claude -p` (or `claude --bg` where a human may need to take over) in plugin-made worktrees, plugin hooks appending events to the run directory, and a poll of `claude agents --json --all` as a liveness probe.
- Gaps: no blocking wait command (poll instead), no documented scripted answer to a dialog in a background session, `worktree.baseRef` cannot name a branch, agent view is a research preview, and Desktop documents no scripting surface. None of these needs herdr; all are small scripts.

## How herdr works

**Process model.** A background server owns the panes and their processes; a client is the terminal UI attached to it, and detaching leaves everything running ([concepts][h-concepts]). After a server restart the processes are gone and only the layout returns, plus native agent session restore where an integration reported a session id ([session state][h-session]). It is a Rust binary with a vendored libghostty-vt terminal engine ([repo][h-repo]), pre-1.0 (v0.9.5), Apache-2.0, 47.5k stars, 408 open issues and PRs, last push 2026-11-01 ([GitHub API][h-api]). It runs on Linux, macOS and Windows ([install][h-install]).

**Layout, pane, agent.** Workspace, tab and pane are layout; an agent is whatever recognized process currently runs in a pane. `agent start` needs an existing shell pane and never creates layout ([agent automation][h-auto]). Agents have optional unique names and are addressed by name or pane id.

**State classification.** For Claude Code the state comes from the live bottom of the pane matched against a detection manifest; the Claude hook reports session identity only, and only the Pi, OMP, Kimi, OpenCode, Kilo and MastraCode integrations report state ([agents][h-agents], [integrations][h-integ]). herdr moved Claude, Codex, Copilot, Droid, Kimi and Qoder to identity-only in 0.6.7 ([changelog][h-log]). The Claude manifest (`2026.10.11.1`) matches OSC-title spinner glyphs and `esc to interrupt` lines as working, `Do you want to proceed?` plus option lines as blocked, and the `❯` prompt box as idle; a comment in the file pins glyph sets to Claude Code versions (Braille spinner frames up to 2.1.227, half-circle frames from 2.1.228) ([claude.toml][h-claude]). Manifests update from herdr.dev without a restart and local overrides win ([agents][h-agents]).

| State | Meaning in herdr |
|---|---|
| `blocked` | A recognized approval, question or permission UI. Detection is strict by design: an unmatched new prompt falls back to `idle`, and the docs warn that automation trusting that idle can type into an approval dialog ([agents][h-agents]) |
| `working` | Actively running |
| `done` / `idle` | Both mean ready for input. `done` is idle and not yet viewed; "seen" is tracked per client, so the CLI and each TUI can disagree ([concepts][h-concepts], [CLI][h-cli]) |
| `unknown` | Agent present, lifecycle not classifiable; the docs stress it is not evidence of success ([agent automation][h-auto]) |

**Fragility is documented.** 22 changelog entries across 61 releases (2026-03-27 to 2026-10-14) pair Claude Code with detection, blocked, idle, working or spinner, for example the 0.9.5 hotfix that makes Claude Code questions in named sessions show as blocked ([changelog][h-log]). That is the cost of reading a UI that Claude Code changes every week.

**Control surface** ([agent automation][h-auto], [CLI][h-cli]):
- `agent start NAME --kind claude --pane P -- <args>` returns once the agent is detected and ready (30 s default); `agent prompt` writes text plus Enter honouring bracketed paste; `agent send-keys` for `esc`, `enter`, `ctrl+c`.
- `agent wait` / `agent prompt --wait` default to `idle|done|blocked`; repeat `--until` for exact states. No default timeout. An already-`blocked` agent returns `agent_blocked` without sending input. After a prompt from a non-working state it waits up to 5 s to see `working` or `blocked`, else returns `agent_prompt_stalled`. It does not track individual turns, so a wait can be satisfied by the end of an earlier turn.
- A timeout or stall does not prove the prompt was never delivered, so a blind retry can submit it twice.
- `agent read --source visible|recent|recent-unwrapped|detection`; `pane wait-output --regex` polls rendered rows for ordinary processes, and the server implements output waits as a polling loop ([wait.rs][h-wait]).

**Socket API.** Newline-delimited JSON over a Unix socket (named pipe on Windows) under `~/.config/herdr/`, with `events.subscribe` for `pane.agent_status_changed`, `worktree.created` and others. History is not durable: a slow subscriber gets `events_lost` and must reconcile from `session.snapshot` ([socket API][h-sock]). `herdr api schema` prints the JSON Schema. Panes inherit `HERDR_PANE_ID`, `HERDR_SOCKET_PATH` and `HERDR_BIN_PATH` ([add support][h-support]).

**Worktrees.** `worktree create [--branch] [--base REF] [--path]` runs `git worktree`, opens it as a workspace grouped with the parent repo, and defaults to `<worktrees.directory>/<repo>/<branch-slug>`; `worktree remove` runs `git worktree remove` and never deletes the branch ([CLI][h-cli]). Unlike Claude Code's own setting, `--base` takes any ref.

**Resume.** Detach/reattach is the strong path. After a server restart herdr re-runs `claude --resume <id>` for panes whose Claude hook (integration v6 or newer) reported a session; other panes return as plain shells ([session state][h-session]).

## Native equivalents, job by job

| Job | herdr | Claude Code native | Fit |
|---|---|---|---|
| Start | `agent start`, `agent prompt` into a pane | `claude --bg --name N "prompt"` returns a short id and runs under a supervisor with no terminal ([dispatch][cc-av-bg]). `claude -p "prompt"` for a child process ([headless][cc-head]). Agent SDK `query()` for code ([SDK][cc-sdk-ts]). `--agent`, `--model`, `--permission-mode`; in `-p` only, `--max-turns`, `--max-budget-usd`, `--json-schema` ([CLI flags][cc-cli]) | Full. `--bg` rejects `-p`; they are two modes |
| Watch state | `agent get/list`, `pane.agent_status_changed` events, `agent read` (screen-scraped) | `claude agents --json [--all] [--cwd]` gives `id`, `state`, `status` (`busy|waiting|idle`), `waitingFor` (`permission prompt`, `input needed`, `sandbox request`, `worker request`, `dialog open`), `sessionId` ([JSON][cc-av-json]); `claude logs <id>`; `-p` stream-json events and `system/api_retry` ([stream][cc-head-stream]); SDK `session_state_changed` = `idle|running|requires_action`, behind `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` ([SDK][cc-sdk-state], [env][cc-env]) | Full, and structured. The docs name `claude agents --json` as the supported way to read state from outside and mark `~/.claude/jobs/*` as not a stable interface ([state][cc-av-state]) |
| Push signal | socket subscription | Hooks: `PermissionRequest` fires the moment a prompt would show (the `permission_prompt` notification waits about six seconds) ([hooks][cc-hooks-perm]); `Stop` carries `last_assistant_message` and `background_tasks`, so "done" can be told from "paused for background work" ([Stop][cc-hooks-stop]); `StopFailure` for rate limits ([StopFailure][cc-hooks-fail]); `SubagentStop` ([SubagentStop][cc-hooks-sub]) | Full for events; see gap 2 for the `Notification` caveat |
| Wait until blocked or done | `agent wait --until blocked`, `agent prompt --wait` | No blocking command. Poll `claude agents --json --all` and read `state`. For `-p`: the process exit code (0 on success) and the final `result` message ([headless][cc-head]). In the SDK: iterate to `result`. From a Claude session: `SendMessage` with `notify_when_idle`, local sessions only, dropped after 12 hours ([messaging][cc-x-idle]) | Partial: a ten-line poll loop |
| Interrupt or stop | `agent send-keys esc`, `ctrl+c` | `claude stop <id>`; in a peek reply `/stop`; for `-p` send SIGINT to end the turn (SIGTERM abandons the turn mid-flight) ([signals][cc-head-sig]); SDK `interrupt()`, `stopTask()` | Full |
| Resume | Server restart: `claude --resume <id>` from the reported session id | `claude --resume <id|name>`, `--continue`, `claude -p --resume <id>`, `claude respawn <id>`, `claude --resume <id> --bg` ([sessions][cc-sess], [running bg][cc-sess-run]). The supervisor reconnects after sleep and auto-update, and restarts a session whose process died ([supervisor][cc-av-sup]). Transcripts persist, 30 days by default ([storage][cc-sess-store]) | Full, and stronger: no multiplexer to lose |
| Parallel workspaces | `worktree create --branch --base`, tabs, panes | `claude --bg` moves each session into `.claude/worktrees/` before its first edit unless it already sits in a linked worktree ([isolation][cc-av-iso]); `claude -w name`; subagent `isolation: worktree` ([worktrees][cc-wt-iso]); `WorktreeCreate` hook to replace creation; Claude holds a worktree lock while a session runs ([locks][cc-wt-sub]) | Full, except choosing the base branch (gap 4) |
| Take over / attach | `agent attach`, the TUI | `claude attach <id|name>`, peek and reply in `claude agents`; a `Needs input` row shows the question | Full for humans |
| Many agents on one screen | sidebar rollups | `claude agents` groups by Needs input, Working, Completed ([agent view][cc-av-state]); Desktop sidebar with split view ([Desktop][cc-desk]) | Full for humans |

In-session work has matching pieces: subagents Claude spawns run in the background with nothing configured, and a completion notification arrives in a later turn ([sub-agents][cc-sub-bg]); cross-session messaging lets one Claude message another and exposes a per-session inbox socket to hooks and scripts ([messaging][cc-x-sock]); dynamic workflows run a script that holds the plan over many subagents ([workflows][cc-wf]).

**Desktop-app sessions** are a human surface: parallel sessions, optional per-session worktree, an OS notification when a session finishes while you look elsewhere ([Desktop][cc-desk], [notifications][cc-desk-notif]). The page documents no CLI or API to dispatch or poll them, and Claude inside Desktop only sees sessions the app itself runs ([cross-session section][cc-desk-x]). `claude --desktop` just opens the app on a directory ([CLI][cc-cli]). Treat Desktop as a place to review a run, not to drive one.

## The combination, concretely

Three native transports, picked per stage, with files as the system of record:

1. **Unattended stage run, the default.** `claude -p --output-format stream-json --verbose --permission-mode <mode> --permission-prompts none --max-turns M --max-budget-usd B --json-schema …` launched in a worktree the plugin made. A `-p` run in Manual mode denies any call needing approval unless a `PermissionRequest` hook or `--permission-prompt-tool` answers, so it does not sit blocked; denials surface as `permission_denied` events and `permission_denials` in the result ([headless][cc-head-perm]). Read the session id from the `system/init` event ([init][cc-head-stream]); resume with `claude -p --resume <id>`; end a turn with SIGINT. Do not add `--bare`: it skips hooks, plugins and `CLAUDE.md`, and does not use the subscription login ([headless][cc-head]).
2. **Run a human may need to take over.** `claude --bg --name <run>-<ticket> "…"` started inside the worktree, polled with `claude agents --json --all --cwd <repo>`. `blocked` plus `waitingFor` maps onto the factory's `needs-human`; `claude attach <id>` is the takeover.
3. **Push events in both.** Plugin hooks on `PermissionRequest`, `Stop`, `StopFailure`, `SubagentStop` and `SessionEnd` append one JSON line each to `.factory/runs/<id>/events.jsonl`. Settings hooks run in `-p` sessions unless `--bare` is set ([headless][cc-head]); a background session reads the settings of the directory it runs in and carries over plugin and MCP flags ([agent view][cc-av-perm]).

## Gaps

1. **No blocking wait.** herdr's `--until blocked` has no native twin; the documented route is polling `claude agents --json` ([state][cc-av-state]). The `Notification` hook types `agent_needs_input` and `agent_completed` fire only while agent view is open in a terminal, so they cannot be the wait ([Notification][cc-hooks-notif]). Use the in-session hooks above.
2. **Answering a blocked background session from a script is not documented.** A peek reply to a permission prompt or dialog sits in the queue until you attach ([peek][cc-av-peek]); `claude --resume <id> "prompt"` on a running session attaches a terminal and refuses with piped input or output ([resume][cc-sess-run]). Ways round it, all untested here: decide in a `PermissionRequest` hook, keep stage runs in `-p` where nothing blocks, use the SDK `canUseTool` callback, or `PreToolUse` `defer` in `-p` for a single tool call per turn (the turn ends with `stop_reason: "tool_deferred"`, resume later) ([defer][cc-hooks-defer]). The inbox socket takes messages but follows the session's inbound controls ([socket][cc-x-sock]).
3. **Agent view is a research preview.** The page warns the interface and shortcuts may change, and flags arrived release by release since its introduction in v2.1.139 ([preview note][cc-av], [version history][cc-av-ver]). Sessions are local, stop at machine shutdown, and each uses quota independently ([limitations][cc-av-lim]).
4. **Worktree base is `fresh` or `head`, never a named branch.** For a specific branch the docs say to create the worktree with git yourself ([base][cc-wt-base]). The factory's lanes (`develop`, `main`, hotfix) therefore need the plugin to run `git worktree add` from `base_sha`; a session already inside a linked worktree is not moved again ([isolation][cc-av-iso]).
5. **Auto-deletion of worktrees.** The periodic sweep removes Claude-created worktrees older than `cleanupPeriodDays` unless they hold changes or unpushed commits; worktrees the plugin creates with `git worktree add` are left alone ([worktrees][cc-wt-sub]).
6. **Subagents no longer block by default.** In interactive sessions Claude cannot wait for a subagent while fork mode is on, which is the default from v2.1.302; results arrive as notifications ([fork mode][cc-sub-fork]). The orchestrator must not assume a synchronous return.
7. **SDK authentication.** The SDK overview points third-party developers at API-key auth and says Anthropic does not allow offering claude.ai login in products built on it ([SDK overview][cc-sdk-over]). `claude -p` and `--bg` use the user's own login. This matters only if the factory ships a supervisor built on the SDK.
8. **Cloud routes** (Projects, `--cloud`, scheduled routines) need a cloud environment and are outside "without herdr" ([agents][cc-agents]).

What herdr still does better: it drives any vendor's agent; its `agent read` shows the exact terminal; `events.subscribe` pushes without polling; `--base` takes any ref; detach/attach works for any process, not only Claude sessions. None of that is a factory requirement.

## Implications for the factory

**Keep: skip herdr in the plugin.** The catalogue verdict in `docs/design/design.md` ("Optional supervisor for long runs in v3. Skip for the plugin") stands and gets firmer. For Claude Code, herdr's one real job, classifying state, is now available as structured fields from the process itself, while herdr's version depends on matching a UI that changes weekly. Benefit: no binary to install, no `setup-factory` step, no second source of truth for state. Trade-off: no pushed events and no blocking wait, so the factory polls or uses hooks.

**Change: drop herdr from the v3 line** ("headroom and herdr as user-level options"). Keep it as something a user may run themselves; the plugin should neither detect nor depend on it. Update the catalogue's numbers (the doc says 46.2k stars and 422 issues; the API now reports 47.5k and 408).

**Change: define `scripts/run-stage.sh` (v2) as a thin launcher with two modes** (`-p` default, `--bg` on request) and record the session id next to the agent id in the `run-state.mjs dispatch` record. Benefit: reconcile can ask `claude agents --json --all` whether a session is `working`, `blocked` or `stopped` and resume it by id, instead of inferring from files alone. Trade-off: one more field in `state.json`, and a dependency on a research-preview command for the `--bg` mode only; the `-p` mode depends on nothing preview. The design keeps `state.json` and the `ACTIVE` lock as the system of record; `claude agents --json` is a probe, never the record.

**Add: one hook script, `log-event.mjs`,** registered for `PermissionRequest`, `Stop`, `StopFailure`, `SubagentStop` and `SessionEnd`, writing to `events.jsonl`. It gives the push signal herdr's subscription gave, from first-party events. Benefit: works in interactive, `-p` and `--bg` sessions with no agent view open. Trade-off: more hook surface to test, and `Stop` does not fire on a user interrupt, so a missing `Stop` is not proof of a live run; pair it with the liveness probe.

**Change: create run worktrees with `git worktree add` from `base_sha`,** following the claude-squad recipe the catalogue already adopts (create from a recorded base SHA), rather than `claude --worktree`. Benefit: git-flow lanes and the recorded base SHA stay in the plugin's hands, and Claude's sweep leaves the worktrees alone. Trade-off: the plugin owns creation, locks and cleanup; start `--bg` inside the worktree so Claude does not isolate again.

**Add to v1 testing: subagent wait behaviour.** Verify in the first dry run that the orchestrator reads stage results from files after a background completion notification, and decide whether `setup-factory` sets `CLAUDE_CODE_FORK_SUBAGENT=0` for a synchronous flow. This follows from gap 6, not from herdr, but it is the in-session half of "wait until done".

**Do not build a supervisor on the Agent SDK yet.** It adds a Node or Python process (the daemon the design avoids), API-key auth per the SDK docs, and nothing `claude -p` plus hooks lacks. Revisit for v3 only if the factory needs `canUseTool` to answer permission prompts from GitHub comments, or `session_state_changed` for a live view.

**Open items to test before relying on this** (none was run for this note): that plugin hooks fire inside `--bg` sessions; that `claude --resume <id> --bg` continues a stopped session under the same id; the latency and field stability of `claude agents --json` on a machine with several sessions; and whether `--permission-prompts none` plus `acceptEdits` leaves any stage dependent on a prompt.

[h-repo]: https://github.com/herdrdev/herdr
[h-api]: https://api.github.com/repos/herdrdev/herdr
[h-install]: https://github.com/herdrdev/herdr/blob/master/docs/versions/0.9.5/website/src/content/docs/install.mdx
[h-concepts]: https://github.com/herdrdev/herdr/blob/master/docs/versions/0.9.5/website/src/content/docs/concepts.mdx
[h-agents]: https://github.com/herdrdev/herdr/blob/master/docs/versions/0.9.5/website/src/content/docs/agents.mdx
[h-auto]: https://github.com/herdrdev/herdr/blob/master/docs/versions/0.9.5/website/src/content/docs/agent-automation.mdx
[h-integ]: https://github.com/herdrdev/herdr/blob/master/docs/versions/0.9.5/website/src/content/docs/integrations.mdx
[h-session]: https://github.com/herdrdev/herdr/blob/master/docs/versions/0.9.5/website/src/content/docs/session-state.mdx
[h-cli]: https://github.com/herdrdev/herdr/blob/master/docs/versions/0.9.5/website/src/content/docs/cli-reference.mdx
[h-sock]: https://github.com/herdrdev/herdr/blob/master/docs/versions/0.9.5/website/src/content/docs/socket-api.mdx
[h-support]: https://github.com/herdrdev/herdr/blob/master/docs/versions/0.9.5/website/src/content/docs/add-herdr-support.mdx
[h-claude]: https://github.com/herdrdev/herdr/blob/master/src/detect/manifests/claude.toml
[h-wait]: https://github.com/herdrdev/herdr/blob/master/src/api/wait.rs
[h-log]: https://github.com/herdrdev/herdr/blob/master/CHANGELOG.md
[cc-log]: https://code.claude.com/docs/en/changelog.md
[cc-agents]: https://code.claude.com/docs/en/agents.md
[cc-av]: https://code.claude.com/docs/en/agent-view.md
[cc-av-state]: https://code.claude.com/docs/en/agent-view.md#read-session-state-from-a-script
[cc-av-json]: https://code.claude.com/docs/en/agent-view.md#list-sessions-as-json
[cc-av-shell]: https://code.claude.com/docs/en/agent-view.md#manage-sessions-from-the-shell
[cc-av-bg]: https://code.claude.com/docs/en/agent-view.md#dispatch-an-agent-from-your-shell
[cc-av-iso]: https://code.claude.com/docs/en/agent-view.md#how-file-edits-are-isolated
[cc-av-peek]: https://code.claude.com/docs/en/agent-view.md#peek-and-reply
[cc-av-sup]: https://code.claude.com/docs/en/agent-view.md#the-supervisor-process
[cc-av-perm]: https://code.claude.com/docs/en/agent-view.md#settings-plugins-and-mcp-servers
[cc-av-lim]: https://code.claude.com/docs/en/agent-view.md#limitations
[cc-av-ver]: https://code.claude.com/docs/en/agent-view.md#version-history
[cc-head]: https://code.claude.com/docs/en/headless.md
[cc-head-stream]: https://code.claude.com/docs/en/headless.md#stream-responses
[cc-head-perm]: https://code.claude.com/docs/en/headless.md#turn-off-permission-prompts-in-unattended-runs
[cc-head-sig]: https://code.claude.com/docs/en/headless.md#stop-a-run-with-sigterm
[cc-cli]: https://code.claude.com/docs/en/cli-reference.md
[cc-env]: https://code.claude.com/docs/en/env-vars.md
[cc-hooks-notif]: https://code.claude.com/docs/en/hooks.md#notification
[cc-hooks-perm]: https://code.claude.com/docs/en/hooks.md#permissionrequest
[cc-hooks-stop]: https://code.claude.com/docs/en/hooks.md#stop
[cc-hooks-fail]: https://code.claude.com/docs/en/hooks.md#stopfailure
[cc-hooks-sub]: https://code.claude.com/docs/en/hooks.md#subagentstop
[cc-hooks-defer]: https://code.claude.com/docs/en/hooks.md#defer-a-tool-call-for-later
[cc-sub-bg]: https://code.claude.com/docs/en/sub-agents.md#run-subagents-in-foreground-or-background
[cc-sub-fork]: https://code.claude.com/docs/en/sub-agents.md#turn-fork-mode-off
[cc-sess]: https://code.claude.com/docs/en/sessions.md#resume-a-session
[cc-sess-run]: https://code.claude.com/docs/en/sessions.md#resume-a-running-background-session
[cc-sess-store]: https://code.claude.com/docs/en/sessions.md#where-transcripts-are-stored
[cc-wt-base]: https://code.claude.com/docs/en/worktrees.md#choose-the-base-branch
[cc-wt-iso]: https://code.claude.com/docs/en/worktrees.md#isolate-subagents-with-worktrees
[cc-wt-sub]: https://code.claude.com/docs/en/worktrees.md#clean-up-subagent-and-background-session-worktrees
[cc-x-idle]: https://code.claude.com/docs/en/cross-session-messaging.md#get-a-notice-when-another-session-goes-idle
[cc-x-sock]: https://code.claude.com/docs/en/cross-session-messaging.md#the-sessions-inbox-socket
[cc-desk]: https://code.claude.com/docs/en/desktop.md#work-in-parallel-with-sessions
[cc-desk-notif]: https://code.claude.com/docs/en/desktop.md#get-notified-when-a-session-finishes
[cc-desk-x]: https://code.claude.com/docs/en/desktop.md#work-across-sessions
[cc-sdk-ts]: https://code.claude.com/docs/en/agent-sdk/typescript.md
[cc-sdk-state]: https://code.claude.com/docs/en/agent-sdk/typescript.md#sdksessionstatechangedmessage
[cc-sdk-over]: https://code.claude.com/docs/en/agent-sdk/overview.md
[cc-wf]: https://code.claude.com/docs/en/workflows.md
