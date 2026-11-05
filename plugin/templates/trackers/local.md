# Tracker: local

Nothing lives outside the repo: what a run needs stays under `.factory/`.

## Run operations

None. A run under `local` has no request issue: every request is plain text, and no run writes to a tracker.

## Wayfinding operations

A map is a folder on the `factory/records` branch, `.factory/maps/<slug>/` (the base's until the first write makes that branch). Only `node ${CLAUDE_PLUGIN_ROOT}/scripts/map.mjs` (`map.mjs` below) writes it, each write a commit on `factory/records`, never the base, so never edit these files in a checkout. Pass a file's text on stdin through a quoted heredoc, with a delimiter no line of the text matches.

- **Map**: `map.md` in that folder holds the body, and the map's reference is its slug (`crm`). Write it whole with `map.mjs write <slug> map.md`, which refuses a text that drops a decision another session added since you read it (and a ticket's write that changes its `Status:` other than to `out-of-scope`): read it again, then write. Read it with `git show <base>:.factory/maps/<slug>/map.md`, `<base>` being the branch runs start from.
- **Decision ticket**: `tickets/NN-<slug>.md`, numbered from `01` in the order they are made: a `# <title>` line, then `Type: research | grilling | task`, `Status: open` and `Blocked by: none` lines, then the body. Write one whole with `map.mjs write <slug> tickets/NN-<slug>.md`.
- **Blocking**: the `Blocked by:` line names each ticket it waits on by number (`Blocked by: 02, 05`). Numbers are known before the files exist, so each ticket is written with its edges at once.
- **Frontier**: `map.mjs frontier <slug>` prints a `NEXT` line per takeable ticket, the first winning; with none, why each open ticket waits; `CLEAR` once every ticket is closed.
- **Claim**: `map.mjs claim <slug> <NN>`. When the ticket isn't open at the tip any more, another session having claimed it first, it fails and commits nothing: take the next `NEXT` line. Any other failure says why.
- **Resolve**: `map.mjs resolve <slug> <NN> --gist "<one line>"`, the answer on stdin: it records the answer in the ticket, closes it and adds its pointer to the map's `## Decisions so far`, in one commit. To rule a ticket out of scope, write it again with `Status: out-of-scope`, then write `map.md` with its line under `## Out of scope`.
- **Read a closed decision ticket**: `git show <base>:.factory/maps/<slug>/tickets/NN-<slug>.md`; its answer is under `## Answer`.
