# Platform facts

Claude Code behaviour the factory relies on, each proven by a probe before a build slice depends on it. A fact the docs state is still probed, because the factory's design breaks if it's wrong. Each entry gives the claim, what the docs say, the probe and its result, with the Claude Code version it ran on.

## From [A run starts, triages and holds](https://github.com/thedammyking/factory/issues/37)

The probes use a throwaway repo with a run worktree nested at `.factory/worktrees/r1/` (gitignored), a probe plugin with three haiku agents, and a stdio MCP server exposing one tool, `ping`.

### 1. A `--bg` session writing into the nested run worktree stays where it is

- **Claim.** A `claude --bg` session that writes into `.factory/worktrees/<run>/`, through the Write tool or through Bash (as `run-state.mjs` does), isn't moved into `.claude/worktrees/`.
- **Docs.** [Agent view, how file edits are isolated](https://code.claude.com/docs/en/agent-view.md): the move is skipped when "the file that Claude is editing is inside a linked git worktree". They don't say whether a write through Bash counts as an edit.
- **Probe.** In the repo, `claude --bg` writes one file with Write and one with `echo … >` into `.factory/worktrees/r1/.factory/runs/r1/`, then records `pwd`. Pass: both files exist there, `.claude/worktrees/` doesn't exist, and `git worktree list` shows no new worktree.
- **Result.** Not run yet: the `claude` CLI on the build machine was signed out (2.1.316, 2026-11-03).

### 2. A background subagent's completion wakes the session

- **Claim.** When the orchestrator dispatches a background subagent and ends its turn, the completion notification starts its next turn with no human input.
- **Docs.** [Subagents](https://code.claude.com/docs/en/sub-agents.md): "A background subagent's results reach Claude as a completion notification in a later turn". They don't say the notification wakes an idle session. Fork mode, on by default since 2.1.302, stops Claude from waiting for a subagent in interactive sessions.
- **Probe.** The same `--bg` session starts `probe:sleeper` (sleeps 25 s) in the background, ends its turn, and on the notification writes `woken.txt`. Pass: `woken.txt` appears without input.
- **If it fails.** `/setup-factory` must set `CLAUDE_CODE_FORK_SUBAGENT=0`, so the orchestrator can wait for each stage in the foreground.
- **Result.** Holds in the desktop app (Claude Code 2.1.316, desktop 4.4212.0, fork mode at its default, 2026-11-03): the session that built this slice dispatched two background review agents and ended its turn, and each agent's completion notification started a new turn with no human input. Not run yet in a `--bg` session (see 1).

### 3. A plugin agent's `tools:` allowlist drops inherited MCP tools

- **Claim.** A plugin agent with an explicit `tools:` list sees none of the session's MCP tools; one without `tools:` sees them all.
- **Docs.** [Subagents](https://code.claude.com/docs/en/sub-agents.md): with `tools` set to Read, Grep, Glob and Bash, "the subagent can't edit files, write files, or use any MCP tools".
- **Probe.** `claude -p --strict-mcp-config --mcp-config <ping server> --plugin-dir <probe>` dispatches `probe:narrow` (`tools: Read, Bash(git ls-files:*), Bash(git log:*)`) and `probe:wide` (no `tools:`), and each lists its tools. Pass: `mcp__probemcp__ping` appears for `wide` only. The same probe shows whether a `Bash(…)` specifier in `tools:` restricts Bash, which the docs don't cover. Until it does, the triager takes plain `Bash` and keeps to read-only git by its prompt and the permission system: read-only git runs without a prompt, and anything else asks the human or, unattended, is denied.
- **Result.** Not run yet (see 1).
