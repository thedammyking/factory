# Tracker: Linear

Request issues live in Linear, reached through the Linear MCP's tools in the orchestrator's session; no script can reach it. Linear moves an issue when its PR opens and merges only through Linear's GitHub integration (https://linear.app/docs/github), which the factory can't check: without it, the claim is the only move a run makes.

## Run operations

- **Read a reference**: `ENG-123` (a team key, a dash and a number), or the issue's URL (`https://linear.app/<workspace>/issue/ENG-123/<slug>`). Get the issue by its identifier and keep only its identifier, URL, title and description; never read its comments. `run-state init` refuses a Linear reference on its own.
- **Claim**: read the issue's state and assignee, and its team's workflow states. Move the issue to the team's first state of type `started` (the lowest position) unless it is in that state already, and assign it to yourself, the MCP's current user, unless it is yours already. What it changed is `--state "<the state it was in>"` when it moved, and `--assigned` when you assigned it. To undo the claim, move the issue back to `state`, and unassign yourself when `assignee` is true.
- **Closing reference**: `Fixes ENG-123`, which `pr-render` puts in the PR body.
- **Comment**: create a comment on the issue whose body is the text, as it is.
- **File**: create an issue with the `title` and `body` (its description) that `run-state file-issue` printed, in your team (the map's team when it printed a `parent`, else ask which when the MCP's current user is in more than one), assigned to yourself, its parent `parent` when it printed one. Its identifier is the key to record, and its closing reference is `Fixes <identifier>`. Nothing claims or unclaims it.
- **Spec comment**: create a comment on `issue` whose body is `body`, as it is, as **Comment** does. The issue's description is never changed.
- **File tickets**: for each ticket `run-state file-tickets` printed, in its order, create an issue whose parent is `parent`, titled `title`, its description `body`, then a `blocks` relation to it from each ticket its `blocked_by` names, which were filed before it.
- **Move**: on each `TRACK <key> <phase>` line a `run-state` command prints (#81), move the issue `<key>` by its team's workflow states: `planning` and `building` to the first state of type `started`, `reviewing` and `in-pr` to the started state named like "In Review" (else leave it started), `failed` back to the first state of type `unstarted`, and `needs-you` leaves it where it is. Then add the label `factory:<phase>` in place of the last `factory:` one, creating it in the team when it lacks it. A move that fails is skipped: nothing records it.
- **Close ticket**: move the issue to its team's first state of type `completed`. To close one as not planned, move it to the first state of type `canceled` instead.

## Wayfinding operations

A map is a Linear issue and its decision tickets are its sub-issues, all through the Linear MCP's tools in the session. Linear gives a sub-issue its parent's assignee, so the map itself is never assigned.

- **Map**: an issue in the team the human names, whose description is the map's body. Its reference is its identifier (`ENG-200`) or its URL. Read it by its identifier, keeping only its identifier, URL and description; write it by updating the description.
- **Decision ticket**: an issue whose parent is the map, its description the ticket's body (the `Type:` line first), left unassigned.
- **Blocking**: a `blocks` relation from the blocking ticket to the one it blocks, added once both exist.
- **Frontier**: the map's sub-issues in the map's order, keeping those whose state is of neither type `completed` nor `canceled`, that have no assignee, and that no open ticket blocks. The first wins.
- **Claim**: assign the ticket to yourself, the MCP's current user, before any other write.
- **Resolve**: comment on the ticket with the answer, move it to its team's first state of type `completed`, then append its pointer to the map's `## Decisions so far`. To rule a ticket out of scope, move it to the first state of type `canceled` instead, and give it a line under `## Out of scope`.
- **Read a closed decision ticket**: get it by its identifier: its title and description, and its comments for the answer.
