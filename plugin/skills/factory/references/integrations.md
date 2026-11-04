# integrations

The factory skill reads this before step 1 of **New run**, when the run will use the tracker (`tracker` in `.factory/config.json` isn't `local`) or Notion (`docs` is `notion`). Setup tested them once; this catches a connection that broke since, before triage rather than at the run's first write.

## Test

Test each one the run will use with one read:

- `github`: `gh auth status`.
- `linear`: list the teams through the Linear MCP.
- `other`: one read through what `.factory/tracker.md`'s **Run operations** use, its MCP server's tools or its command.
- Notion: fetch the page `notion_parent` names through the Notion MCP.

A server whose only tool is its sign-in (`…__authenticate`) fails, as does a read that fails or is refused. With no failure, say nothing and go on to step 1.

## A failure

Ask about each one that failed, in one call (see **Questions** in the skill): "<The tracker | Notion> failed its test: <why>. <what to do>". What to do is `gh auth login` for `github` and connecting the server with `/mcp` for an MCP server; for a Notion page it can't find, it's sharing the page with the Notion connection, or signing that connection in to the page's workspace with `/mcp`. The options:

- `Check again` (Recommended), once the human has fixed it: the run keeps its copy on the tracker or in Notion, at the cost of waiting for the fix. Test it again, and ask again while it fails.
- `Go on without it`: the run starts now, and each tracker write, or the Notion push, is still tried once as it comes due: while the connection stays broken, it fails and is recorded with its `failed` form, and the run carries on. A request that is an issue's reference can't be read without its tracker: say so and stop, with no run made.

With no `AskUserQuestion` among your tools, go on without it.
