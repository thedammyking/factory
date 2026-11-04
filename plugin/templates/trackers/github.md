# Tracker: GitHub Issues

Request issues live as issues on the GitHub repo `origin` names. Everything goes through `gh api` (REST), never GraphQL, and for a run `run-state.mjs` makes every call itself.

## Run operations

- **Read a reference**: `#12`, or the issue's URL (`https://github.com/<owner>/<repo>/issues/12`) on origin's repo. `run-state init` reads its title and body itself, once, and never its comments. Another repo's issue or a pull request starts no run.
- **Claim**: `run-state claim` assigns the issue to you (`@me`) unless you already were when the run started, and records whether it did. `run-state unclaim` undoes only that: it unassigns you only if the claim assigned you.
- **Closing reference**: `Closes #12`, which `pr-render` puts in the PR body. GitHub closes the issue when the PR merges into the default branch, and only then.
- **Comment**: `run-state comment` posts the closing comment.
- **File**: `run-state file-issue` files a plain run's request issue once its spec is approved: the spec's title, `spec.md` as its body and you (`@me`) as its assignee. Its closing reference is `Closes #<n>`, and nothing claims or unclaims it. A body over GitHub's 65,536 characters is cut there, its last line pointing to the whole file in history.
- **Spec comment**: `run-state spec-comment` posts the approved spec as one comment on the issue the run started from, whose body is never changed.
- **File tickets**: `run-state file-tickets` files each ticket as an issue titled `NN: <title>`, the ticket file as its body, makes it a sub-issue of the request issue (`repos/<repo>/issues/<n>/sub_issues`) and marks it blocked by each ticket its `Blocked by:` line names (`repos/<repo>/issues/<n>/dependencies/blocked_by`), naming each issue by its database `id`.
- **Close ticket**: `run-state close-ticket <NN>` closes a merged ticket's sub-issue as completed. `run-state abandon` closes the sub-issues still open, and a request issue the run filed, as not planned.

## Wayfinding operations

A map is an issue on origin's repo, `<repo>` below, and its decision tickets are its sub-issues. Each operation is a REST call through `gh api`, never GraphQL, with a body passed as `-F body=@<file>` from a file under `/tmp/factory-<slug>/`. A sub-issue or a dependency names an issue by its database `id`, from the issue's JSON, never by its number.

- **Map**: an issue whose body is the map's body, made with `gh api -X POST repos/<repo>/issues -f title=<title> -F body=@<file>`. Its reference is its number (`#40`) or URL. Read it with `gh api repos/<repo>/issues/<n> --jq .body`, and write it with `gh api -X PATCH repos/<repo>/issues/<n> -F body=@<file>`. It is never assigned.
- **Decision ticket**: an issue made the same way, its body the ticket's body (the `Type:` line first), then made a sub-issue of the map with `gh api -X POST repos/<repo>/issues/<map>/sub_issues -F sub_issue_id=<its id>`.
- **Blocking**: GitHub's own issue dependencies: `gh api -X POST repos/<repo>/issues/<n>/dependencies/blocked_by -F issue_id=<the blocker's id>`.
- **Frontier**: `gh api --paginate repos/<repo>/issues/<map>/sub_issues` lists the tickets in the map's order. Keep the open ones with no assignee whose `issue_dependencies_summary.blocked_by`, a count of open blockers only, is 0. The first wins.
- **Claim**: `gh api -X POST repos/<repo>/issues/<n>/assignees -f 'assignees[]=<your login>'`, with the login from `gh api user --jq .login`, before any other write.
- **Resolve**: comment with the answer (`gh api -X POST repos/<repo>/issues/<n>/comments -F body=@<file>`), close it with `gh api -X PATCH repos/<repo>/issues/<n> -f state=closed -f state_reason=completed`, then append its pointer to the map's `## Decisions so far`. To rule a ticket out of scope, close it with `state_reason=not_planned` instead, and give it a line under `## Out of scope`.
- **Read a closed decision ticket**: `gh api repos/<repo>/issues/<n>` for its title and body, and `gh api repos/<repo>/issues/<n>/comments` for its answer.
