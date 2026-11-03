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
