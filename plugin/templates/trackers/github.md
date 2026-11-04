# Tracker: GitHub Issues

Request issues live as issues on the GitHub repo `origin` names. Everything goes through `gh api` (REST), never GraphQL, and for a run `run-state.mjs` makes every call itself.

## Run operations

- **Read a reference**: `#12`, or the issue's URL (`https://github.com/<owner>/<repo>/issues/12`) on origin's repo. `run-state init` reads its title and body itself, once, and never its comments. Another repo's issue or a pull request starts no run.
- **Claim**: `run-state claim` assigns the issue to you (`@me`) unless you already were when the run started, and records whether it did. `run-state unclaim` undoes only that: it unassigns you only if the claim assigned you.
- **Closing reference**: `Closes #12`, which `pr-render` puts in the PR body. GitHub closes the issue when the PR merges into the default branch, and only then.
- **Comment**: `run-state comment` posts the closing comment.

## Wayfinding operations

A map is an issue on origin's repo, `<repo>` below, and its decision tickets are its sub-issues. Each operation is a REST call through `gh api`, never GraphQL, with a body passed as `-F body=@<file>` from a file under `/tmp/factory-<slug>/`. A sub-issue or a dependency names an issue by its database `id`, from the issue's JSON, never by its number.

- **Map**: an issue whose body is the map's body, made with `gh api -X POST repos/<repo>/issues -f title=<title> -F body=@<file>`. Its reference is its number (`#40`) or URL. Read it with `gh api repos/<repo>/issues/<n> --jq .body`, and write it with `gh api -X PATCH repos/<repo>/issues/<n> -F body=@<file>`. It is never assigned.
- **Decision ticket**: an issue made the same way, its body the ticket's body (the `Type:` line first), then made a sub-issue of the map with `gh api -X POST repos/<repo>/issues/<map>/sub_issues -F sub_issue_id=<its id>`.
- **Blocking**: GitHub's own issue dependencies: `gh api -X POST repos/<repo>/issues/<n>/dependencies/blocked_by -F issue_id=<the blocker's id>`.
- **Frontier**: `gh api --paginate repos/<repo>/issues/<map>/sub_issues` lists the tickets in the map's order. Keep the open ones with no assignee whose `issue_dependencies_summary.blocked_by`, a count of open blockers only, is 0. The first wins.
- **Claim**: `gh api -X POST repos/<repo>/issues/<n>/assignees -f 'assignees[]=<your login>'`, with the login from `gh api user --jq .login`, before any other write.
- **Resolve**: comment with the answer (`gh api -X POST repos/<repo>/issues/<n>/comments -F body=@<file>`), close it with `gh api -X PATCH repos/<repo>/issues/<n> -f state=closed -f state_reason=completed`, then append its pointer to the map's `## Decisions so far`. To rule a ticket out of scope, close it with `state_reason=not_planned` instead, and give it a line under `## Out of scope`.
- **Read a closed decision ticket**: `gh api repos/<repo>/issues/<n>` for its title and body, and `gh api repos/<repo>/issues/<n>/comments` for its answer.
