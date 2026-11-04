# Tracker: GitHub Issues

Request issues live as issues on the GitHub repo `origin` names. Everything goes through `gh api` (REST), never GraphQL, and `run-state.mjs` makes every call itself.

## Run operations

- **Read a reference**: `#12`, or the issue's URL (`https://github.com/<owner>/<repo>/issues/12`) on origin's repo. `run-state init` reads its title and body itself, once, and never its comments. Another repo's issue or a pull request starts no run.
- **Claim**: `run-state claim` assigns the issue to you (`@me`) unless you already were when the run started, and records whether it did. `run-state unclaim` undoes only that: it unassigns you only if the claim assigned you.
- **Closing reference**: `Closes #12`, which `pr-render` puts in the PR body. GitHub closes the issue when the PR merges into the default branch, and only then.
- **Comment**: `run-state comment` posts the closing comment.
