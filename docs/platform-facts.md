# Platform facts

Claude Code behaviour the factory relies on, each proven by a probe before a build slice depends on it. A fact the docs state is still probed, because the factory's design breaks if it's wrong. Each entry gives the claim, what the docs say, the probe and its result, with the Claude Code version it ran on.

## From [A run starts, triages and holds](https://github.com/thedammyking/factory/issues/37)

The probes use a throwaway repo with a run worktree nested at `.factory/worktrees/r1/` (gitignored), a probe plugin with three haiku agents, and a stdio MCP server exposing one tool, `ping`.

### 1. A `--bg` session writing into the nested run worktree stays where it is

- **Claim.** A `claude --bg` session that writes into `.factory/worktrees/<run>/`, through the Write tool or through Bash (as `run-state.mjs` does), isn't moved into `.claude/worktrees/`.
- **Docs.** [Agent view, how file edits are isolated](https://code.claude.com/docs/en/agent-view.md): the move is skipped when "the file that Claude is editing is inside a linked git worktree". They don't say whether a write through Bash counts as an edit.
- **Probe.** In the repo, `claude --bg` writes one file with Write and one with `echo … >` into `.factory/worktrees/r1/.factory/runs/r1/`, then records `pwd`. Pass: both files exist there, `.claude/worktrees/` doesn't exist, and `git worktree list` shows no new worktree.
- **Result.** Holds (2.1.317, 2026-11-03). The Write and the `echo … >` both landed in the run dir, `pwd` stayed the repo root, `.claude/worktrees/` never appeared and `git worktree list` was unchanged. `claude --bg` refuses to start in a folder whose trust prompt hasn't been accepted, even a repo nested inside a trusted folder, so an unattended `--bg` run needs the project trusted first.

### 2. A background subagent's completion wakes the session

- **Claim.** When the orchestrator dispatches a background subagent and ends its turn, the completion notification starts its next turn with no human input.
- **Docs.** [Subagents](https://code.claude.com/docs/en/sub-agents.md): "A background subagent's results reach Claude as a completion notification in a later turn". They don't say the notification wakes an idle session. Fork mode, on by default since 2.1.302, stops Claude from waiting for a subagent in interactive sessions.
- **Probe.** The same `--bg` session starts `probe:sleeper` (told to `sleep 25`) in the background, ends its turn, and on the notification writes `woken.txt`. Pass: `woken.txt` appears without input.
- **If it fails.** `/setup-factory` must set `CLAUDE_CODE_FORK_SUBAGENT=0`, so the orchestrator can wait for each stage in the foreground.
- **Result.** Holds in a `--bg` session (2.1.317, 2026-11-03). The session dispatched the sleeper, replied `dispatched` and ended its turn. Two seconds later the completion notification started a new turn, which wrote `woken.txt` with no input. The sleeper finished early, because Claude Code refuses a standalone `sleep 25` and it returned after 4 s, but the session was already idle when its notification arrived. It also holds in the desktop app (its embedded Claude Code 2.1.309, desktop 4.4212.0, fork mode at its default): the session that built this slice dispatched two background review agents and ended its turn, and each agent's completion notification started a new turn with no human input.

### 3. A plugin agent's `tools:` allowlist drops inherited MCP tools

- **Claim.** A plugin agent with an explicit `tools:` list sees none of the session's MCP tools; one without `tools:` sees them all.
- **Docs.** [Subagents](https://code.claude.com/docs/en/sub-agents.md): with `tools` set to Read, Grep, Glob and Bash, "the subagent can't edit files, write files, or use any MCP tools".
- **Probe.** `claude -p --strict-mcp-config --mcp-config <ping server> --plugin-dir <probe> --allowedTools "Bash(echo *)" …` dispatches `probe:narrow` (`tools: Read, Bash(git ls-files:*), Bash(git log:*)`) and `probe:wide` (no `tools:`). Each lists its tools and tries to call `mcp__probemcp__ping`, loading it through ToolSearch when it has that. Narrow also runs `echo probe > probe.txt`, which the session allows, to show whether a `Bash(…)` specifier in `tools:` restricts Bash, which the docs don't cover. Pass: only `wide` reaches `ping`.
- **Result.** Holds (2.1.316, 2026-11-03). Narrow saw exactly `Read` and `Bash`, with no MCP tool and no ToolSearch, so it couldn't load `ping`. Wide listed `mcp__probemcp__ping` as deferred, loaded it through ToolSearch and got `pong`. A specifier doesn't restrict Bash: narrow's `echo` ran and wrote the file. Only the permission system limits what an agent's Bash runs, so the triager declares plain `Bash` and keeps to read-only git by its prompt and the permission system: read-only git runs without a prompt, and anything else asks the human or, unattended, is denied.

## From [Caps and spend metering](https://github.com/thedammyking/factory/issues/44)

The probes use a throwaway repo and a probe plugin with two haiku agents: `probe:reader` reads a text file and a 16×16 PNG and runs `wc -l` through Bash, and `probe:bigreader` reads a 160 KB file in five pieces. Each probe is a `claude -p --model haiku --output-format stream-json --verbose` child that dispatches one of them. Trimmed copies of what they wrote are the fixtures in `test/fixtures/spend/`: only the fields the spend parser reads, with every text replaced by as many `x`s (at most 1,000), so no path, prompt or summary is kept.

### 4. Transcripts carry each API response's `usage`, and say where every subagent's is

- **Claim.** A session's transcript is `<config dir>/projects/<folder>/<session>.jsonl`, and each of its subagents' is `<session>/subagents/agent-<id>.jsonl` beside it, `<id>` being the agent id the Agent tool returns. Summing the `usage` on its messages measures a stage.
- **Docs.** The transcript format isn't documented.
- **Probe.** The `probe:reader` child. Pass: both transcripts are where claimed, and their sums agree with the child's own final result.
- **Result.** Holds (2.1.317, 2026-11-03), with three traps:
  - Claude Code writes one API response once per content block (thinking, text, each tool use), each line repeating the same `message.id` and `usage`, so a message is counted once by its id.
  - Only `assistant` lines count. The `api-request-blob` lines repeat a request's messages, `tool_use` and `tool_result` blocks included, under `message.role`, so a parser keyed on the role counts them twice.
  - The folder is the session's cwd with every other character than a letter or digit made `-`, so `run-state` finds it by the session id instead.

  The session's transcript summed to 4 input, 36,583 cache-creation and 336 output tokens (82,416 cache reads), the result's `usage` exactly. The subagent's summed to 4, 12,373 and 545 (7,249 reads), and the two together equal the result's `modelUsage` exactly. Tool results are `user` lines of `tool_result` blocks, a string or a list of `text` and `image` blocks (the PNG read is an `image` block), named by the matching `tool_use` id. The Agent tool's own `totalTokens` (12,517) is the subagent's last request only, as #11 found. An assistant message is on disk before its tool runs (a Bash command found its own text in the transcript), so by the time `dispatch` reads the orchestrator's transcript it holds the call. Cache reads are left out of the spend: the transcript of the agent that built this slice, at 52 requests, summed to 238k cache creation and 49k output against 8.9M cache reads, so counting reads would count the context again on every turn. `run-state` reads the config dir from `CLAUDE_CONFIG_DIR` when it's set, else `~/.claude`: a `claude -p` run with `CLAUDE_CONFIG_DIR` pointing at an empty dir wrote its session's transcript under that dir's `projects/` (before it stopped, not signed in there).

### 5. A child's final result has its per-model usage, the whole session's so far

- **Claim.** The `result` line of a `claude -p --output-format stream-json` child has `modelUsage` per model, its own subagents included.
- **Docs.** The Agent SDK's result message documents `modelUsage`. They don't say what a resumed session's result counts.
- **Probe.** The `probe:reader` child, then the same session resumed with `claude -p --resume <session> "/compact"`.
- **Result.** Holds (2.1.317, 2026-11-03). `modelUsage` includes the subagent; the result's `usage` is the main thread only. After `--resume`, `modelUsage` is the session's total so far: round 1's 49,845 plus the compaction's 4,263, 54,108 in all, restored from a `cost-state` line in the transcript, while `model_usage_since_last_result` holds this process's share. So `run-state` counts each child session once, at its latest result; summing the rounds would count round 1 twice. The stream-json log also carries every message, the child's subagents' too (with `parent_tool_use_id`), so tool results, images and compactions are counted from the same log.

### 6. A compaction leaves a `compact_boundary` marker in child and subagent transcripts

- **Claim.** A compaction in a child or in a subagent writes a marker that can be counted.
- **Docs.** The marker isn't documented.
- **Probe.** The child resumed with `/compact` (above), and the `probe:bigreader` child run with `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=2`, so its subagent compacts early.
- **Result.** Holds (2.1.317, 2026-11-03). Each compaction writes `{"type":"system","subtype":"compact_boundary","compactMetadata":{"trigger":"manual" | "auto","preTokens":…}}` to the transcript, then a `user` line with `isCompactSummary: true`; a child's stream-json has the same line with `compact_metadata`. The subagent compacted three times (`auto`) in its own transcript, then stopped early, which doesn't bear on the marker. Two limits:
  - A child's stream-json shows its own compactions, not its subagents'.
  - The compaction's own API call is in no transcript, only in a child's result. The subagent's transcript summed to 81,544 tokens where the session's result puts it at about 144,700, mostly the compactions' uncached input. This is why a subagent's and the orchestrator's spend is labelled an estimate, and why compactions are counted per stage.

## From [guard-paths hook](https://github.com/thedammyking/factory/issues/42)

The probes use a throwaway folder and a probe plugin named `factory`, like the real one, with two haiku agents, `qa` and `implementer`, each told to write a file. Its one PreToolUse hook, on Write, Edit and Bash, logs its stdin plus its own `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PROJECT_DIR` and working directory.

### 7. `agent_type` reaches PreToolUse for a plugin subagent, as `factory:qa`

- **Claim.** A PreToolUse hook firing inside the plugin's `qa` subagent gets an `agent_type` that names it, and the orchestrator's own calls get none, so guard-paths can let only `qa` write the pinned directories. An implementer child, started as `claude -p --agent factory:implementer`, runs the same hook with its own `agent_type`.
- **Docs.** [Hooks, common input fields](https://code.claude.com/docs/en/hooks.md): `agent_type` is "Present when the session uses `--agent` or the hook fires inside a subagent". Their examples are `"Explore"` and `"security-reviewer"`, not a plugin agent's value. They don't say whether a `-p` session started as a plugin's agent loads that plugin's hooks.
- **Probe.** `claude -p --model haiku --plugin-dir <probe> …` dispatches `factory:qa` in the foreground, which writes one file with Write and one with `echo … >`; then the session runs `echo … >` itself. Then `claude -p --agent factory:implementer --model haiku --plugin-dir <probe> …` writes one file. Pass: the subagent's calls carry an `agent_type` and the session's doesn't, and the child's call is logged with its own `agent_type`.
- **Result.** Holds (2.1.317, 2026-11-03). Both of the subagent's calls carried `"agent_type": "factory:qa"` and an `agent_id`; the session's own call carried neither. Every call had the session's `cwd` and `session_id`, which matched `CLAUDE_CODE_SESSION_ID` in the hook's environment. The child's Write carried `"agent_type": "factory:implementer"` and its own `session_id`, with the plugin loaded through `--plugin-dir`. guard-paths matches exactly `factory:qa`, the plugin-scoped name, so no other agent called `qa` gets the exception. Because a subagent works from the session's cwd, the main checkout, guard-paths judges a write by the run of the worktree it lands in. A `claude -p` session with the real `plugin/`, working in a live run's worktree, then had guard-paths deny a Write to the recipe and an `echo … >` outside the worktree, and allow a Write to `src/`.

### 8. A hook's `cwd` follows the session's `cd`, and `CLAUDE_PROJECT_DIR` doesn't

- **Claim.** After the session runs `cd`, the hook input's `cwd` is the new directory, for the session and its subagents alike, while `CLAUDE_PROJECT_DIR` stays where the session started. So guard-paths takes the current worktree from `CLAUDE_PROJECT_DIR`, or one `cd` out of the project would switch it off.
- **Docs.** [Hooks](https://code.claude.com/docs/en/hooks.md): `cwd` is "the new directory after Claude runs `cd`", and `CLAUDE_PROJECT_DIR` is "the project root where the session started". They don't say the same holds for a subagent's calls.
- **Probe.** `claude -p --model haiku --plugin-dir <probe> …` runs `cd /tmp && echo moved`, then dispatches `factory:qa`, then runs `echo … >` itself. Pass: the later calls' `cwd` is `/tmp` and their `CLAUDE_PROJECT_DIR` is the probe folder.
- **Result.** Holds (2.1.317, 2026-11-04). The `cd` stuck: the subagent's calls and the session's later call all had `"cwd": "/private/tmp"`, and the subagent wrote its files there. `CLAUDE_PROJECT_DIR` was the probe folder in every call.

## From [Tickets, the ticket gate and per-ticket plans](https://github.com/thedammyking/factory/issues/46)

### 9. A plugin agent's `tools:` admits an MCP tool by its full name, and a server that isn't connected costs nothing

- **Claim.** The planner keeps its explicit `tools:` list (fact 3) and still reads Figma and Mobbin when their servers are connected, by naming each read tool as `mcp__<server>__<tool>`, so it never gets the servers' write tools. An entry for a server the session doesn't have is ignored.
- **Docs.** [Subagents](https://code.claude.com/docs/en/sub-agents.md): to "give the subagent every tool from one server", the `tools` entry is `mcp__github__*`. They show a single tool's full name only under `disallowedTools`, and don't say what an entry for an absent server does.
- **Probe.** The stdio server from fact 3, exposing `ping`, under `claude -p --model haiku --strict-mcp-config --mcp-config <ping server> --plugin-dir <probe> --allowedTools mcp__probemcp__ping`, dispatching `probe:wild` and then `probe:narrow` (`tools: Read`). Each lists its tools and calls `ping` if it has it. Wild ran twice: with `tools: Read, mcp__probemcp__*, mcp__absentserver__*`, then with `tools: Read, mcp__probemcp__ping, mcp__absentserver__ping`. Pass: wild lists `ping` and gets `pong` both times; narrow has no `ping`; the absent server's entry is no error.
- **Result.** Holds (2.1.317, 2026-11-04). Both times wild saw exactly `Read` and `mcp__probemcp__ping`, not deferred, and got `pong`; narrow saw only `Read`. Neither absent-server entry failed the dispatch or added a tool. So the planner names the read tools under the server names the Figma and Mobbin MCPs are usually added as (`figma`, the Figma plugin's `plugin_figma_figma`, `figma-desktop` and `mobbin`). A server added under any other name stays invisible to it, and a Figma link it couldn't read is recorded as such in `design-ref.md`.

## From [Implement loop on one ticket](https://github.com/thedammyking/factory/issues/47)

The probes use a throwaway repo with one commit and the real `plugin/` loaded through `--plugin-dir`, each child a signed-in `claude -p --model haiku --output-format stream-json --verbose`, started from inside a Claude Code session's Bash as `run-stage.mjs` starts one. That a `claude -p --agent factory:implementer` child loads the plugin's hooks and carries `agent_type: factory:implementer` is fact 7.

### 10. `claude -p --agent factory:implementer` runs the plugin's agent as the session, and `--model` sets its model

- **Claim.** A `-p` child started with `--agent factory:implementer` and `--plugin-dir <plugin>` runs with the implementer's prompt as its own, `${CLAUDE_PLUGIN_ROOT}` substituted, and `--model` decides its model over the agent's frontmatter, so `run-stage` moves round 3 to opus with `--model` alone. The fallback, passing the agent file and `--model` itself, isn't needed.
- **Docs.** [CLI reference](https://code.claude.com/docs/en/cli-reference.md): `--agent` is the "Agent for the current session". They don't cover `-p`, or which of `--model` and the agent's `model:` wins. [Plugin loading](https://code.claude.com/docs/en/plugins/loading.md#name-conflicts): a `--plugin-dir` plugin replaces a same-named installed one, so `run-stage` always passes its own plugin root and never loads two copies.
- **Probe.** `claude -p --agent factory:implementer --model haiku --plugin-dir plugin/ --strict-mcp-config --max-turns 3 --permission-mode acceptEdits --permission-prompts none`, asked to reply with the command its instructions say to run before it finishes. Pass: it answers from the implementer's prompt, and the init event and result name haiku, not the frontmatter's sonnet.
- **Result.** Holds (2.1.317, 2026-11-04). It replied `node <the plugin's absolute path>/scripts/verify.mjs --fast`. The init event listed the plugin as `factory@inline` with `factory:implementer` among its agents, the tools Read, Edit, Write and Bash (this build has no Grep or Glob tool), and the model `claude-haiku-5-5`; the result's `modelUsage` held only `claude-haiku-5-5`. Unlike a subagent's (eval fact 3), a session agent's model follows `--model`.

### 11. `--strict-mcp-config` with no `--mcp-config` loads no MCP server

- **Claim.** A child started with `--strict-mcp-config` and no `--mcp-config` has no MCP server at all: none from the user's or the project's config, none a plugin declares, and no claude.ai connector.
- **Docs.** [CLI reference](https://code.claude.com/docs/en/cli-reference.md): "Only use MCP servers from `--mcp-config`, ignoring all other MCP configurations". They don't say whether plugin servers and claude.ai connectors count as other configurations.
- **Probe.** The child of fact 10, then `claude -p --model haiku --max-turns 1 "Reply OK."` without the flag, in the same repo. Pass: the first init event's `mcp_servers` is empty and the second's isn't.
- **Result.** Holds (2.1.317, 2026-11-04). With the flag, `mcp_servers` was `[]`. Without it, the same session config listed 25: plugin servers (`plugin:context7:context7`, `plugin:chrome-devtools-mcp:chrome-devtools` and others), user-scope servers (`codegraph`, `figma-desktop`) and claude.ai connectors (Notion, Figma, Mobbin and others).

### 12. A `-p` child with `--permission-prompts none` is denied, never blocked, and its result lists each denial

- **Claim.** In a child started with `--permission-mode acceptEdits --permission-prompts none --allowedTools <list>`, a call outside the list that would prompt is refused at once and the child carries on; the result's `permission_denials` names it. `--session-id` sets the child's session id, `--resume` keeps it, and `--max-turns` ends the child with an error result.
- **Docs.** `claude --help`: with `--permission-prompts none`, "anything that would prompt is denied automatically". They don't say what a denial leaves in the result.
- **Probe.** A child with `--session-id <uuid>` and `--allowedTools "Bash(git:*)"` runs `git log --oneline`, `ls`, `curl -sI https://example.com` and a Write of `b.txt`, each in its own call. Then the same session is resumed with `--resume <uuid> --max-turns 1` and told to make two Bash calls.
- **Result.** Holds (2.1.317, 2026-11-04). `git log` ran under its rule, `ls` ran as a read-only command with no rule, and the Write ran under `acceptEdits`. `curl` was denied without a prompt, its tool result saying the session has no approval surface, and the child went on to its reply; the result's `permission_denials` held the `curl` call with its input. The init event's `session_id` was the uuid passed. The resumed child kept that id, ran one call and ended with `subtype: error_max_turns` and exit code 1, so `run-stage` judges a child by the files it left, never by its exit code.
