# Tracker: Linear

Request issues live in Linear, reached through the Linear MCP's tools in the orchestrator's session; no script can reach it. Linear moves an issue when its PR opens and merges only through Linear's GitHub integration (https://linear.app/docs/github), which the factory can't check: without it, the claim is the only move a run makes.

## Run operations

- **Read a reference**: `ENG-123` (a team key, a dash and a number), or the issue's URL (`https://linear.app/<workspace>/issue/ENG-123/<slug>`). Get the issue by its identifier and keep only its identifier, URL, title and description; never read its comments. `run-state init` refuses a Linear reference on its own.
- **Claim**: read the issue's state and assignee, and its team's workflow states. Move the issue to the team's first state of type `started` (the lowest position) unless it is in that state already, and assign it to yourself, the MCP's current user, unless it is yours already. What it changed is `--state "<the state it was in>"` when it moved, and `--assigned` when you assigned it. To undo the claim, move the issue back to `state`, and unassign yourself when `assignee` is true.
- **Closing reference**: `Fixes ENG-123`, which `pr-render` puts in the PR body.
- **Comment**: create a comment on the issue whose body is the text, as it is.
