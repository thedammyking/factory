#!/usr/bin/env bash
# sync-base.sh before-review | before-merge
#   before-review: rebase the feature branch onto the (local or remote) base branch; conflicts → abort rebase, exit 3 (needs-human)
#   before-merge:  report behind_base; with a remote and an open PR, `gh pr update-branch` (a merge, never a rebase); conflicts → exit 3
# Prints one machine-readable line: SYNC <mode> result=<rebased|up-to-date|conflict|merged> base=<sha> head=<sha> [files=...]
set -u
ROOT="$PWD"; while [ ! -d "$ROOT/.factory" ]; do [ "$ROOT" = / ] && { echo "no .factory/ above $PWD" >&2; exit 2; }; ROOT="$(dirname "$ROOT")"; done; cd "$ROOT"
RUN="$ROOT/.factory/runs/$(cat "$ROOT/.factory/runs/ACTIVE" 2>/dev/null)"
# Without a live run there is nothing to back up, and restore_run below would `rm -rf` the whole runs/ directory.
[ -f "$RUN/state.json" ] || { echo "SYNC error: no active run (ACTIVE missing or no state.json)"; exit 2; }
BASE_BRANCH="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).base_branch)' "$RUN/state.json")"
git check-ref-format --branch "$BASE_BRANCH" >/dev/null 2>&1 || { echo "SYNC error: base branch '$BASE_BRANCH' is not a branch name"; exit 2; }  # no option injection
MODE="${1:-before-review}"
# Insurance: the live run directory is untracked; a rebase/merge replaying history that once tracked it can overwrite or delete it.
BK="$(mktemp -d)"; cp -r "$RUN" "$BK/run"
restore_run() { if [ ! -f "$RUN/state.json" ]; then rm -rf "$RUN"; cp -r "$BK/run" "$RUN"; echo "SYNC note: live run dir restored from backup"; fi; rm -rf "$BK"; }
trap restore_run EXIT
if git remote get-url origin >/dev/null 2>&1; then git fetch -q origin "$BASE_BRANCH" 2>/dev/null && BASE_REF="origin/$BASE_BRANCH" || BASE_REF="$BASE_BRANCH"; else BASE_REF="$BASE_BRANCH"; fi
BASE_SHA="$(git rev-parse "$BASE_REF")"; HEAD_SHA="$(git rev-parse HEAD)"
MB="$(git merge-base "$BASE_REF" HEAD)"
if [ "$MB" = "$BASE_SHA" ]; then echo "SYNC $MODE result=up-to-date base=${BASE_SHA:0:7} head=${HEAD_SHA:0:7}"; exit 0; fi
# Every conflict path writes the same attention file: the orchestrator routes on its presence, the human reads it.
attention() { printf '# Attention: sync conflict (%s)\n\n%s\n\nThe branch is untouched (the %s was aborted). Resolve by hand, then /factory resume.\n' "$MODE" "$1" "$([ "$MODE" = before-review ] && echo rebase || echo merge)" > "$RUN/attention-sync.md"; }

case "$MODE" in
  before-review)
    if git rebase -q "$BASE_REF" >/tmp/sync-base.out 2>&1; then
      echo "SYNC before-review result=rebased base=${BASE_SHA:0:7} head=$(git rev-parse --short HEAD) (every SHA changed: re-run verify --full)"
    else
      files="$(git diff --name-only --diff-filter=U | tr '\n' ',')"; git rebase --abort
      echo "SYNC before-review result=conflict base=${BASE_SHA:0:7} head=${HEAD_SHA:0:7} files=${files%,}"
      attention "rebasing onto $BASE_BRANCH conflicts in: ${files%,}"
      exit 3
    fi ;;
  before-merge)
    PRNUM="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).number)}catch{}' "$RUN/pr.json" 2>/dev/null)"
    REPO="$(git remote get-url origin 2>/dev/null | sed -E 's#.*github.com[:/]##; s#\.git$##')"
    if [ -n "$PRNUM" ] && [ -n "$REPO" ]; then
      # With a PR open, GitHub merges the base in server-side (REST; never a rebase after the evidence is pinned). 202 = accepted,
      # 422 = conflict or already up to date. Then fast-forward the local branch to the merge commit.
      if OUT="$(gh api -X PUT "repos/$REPO/pulls/$PRNUM/update-branch" 2>&1)"; then
        # 202 is asynchronous: wait until the server's merge commit (which contains the base) has actually arrived.
        for i in $(seq 1 20); do git fetch -q origin "$(git branch --show-current)" && git merge -q --ff-only FETCH_HEAD 2>/dev/null && git merge-base --is-ancestor "$BASE_SHA" HEAD && break; sleep 3; done
        if git merge-base --is-ancestor "$BASE_SHA" HEAD; then echo "SYNC before-merge result=merged base=${BASE_SHA:0:7} head=$(git rev-parse --short HEAD) (via update-branch; re-run verify --full)"
        else echo "SYNC before-merge result=conflict base=${BASE_SHA:0:7} head=${HEAD_SHA:0:7}"; attention "update-branch was accepted but the merged head did not arrive (or does not fast-forward) within 60 s"; exit 3; fi
      elif echo "$OUT" | grep -qi "already"; then echo "SYNC before-merge result=up-to-date base=${BASE_SHA:0:7} head=${HEAD_SHA:0:7}"
      else echo "SYNC before-merge result=conflict base=${BASE_SHA:0:7} head=${HEAD_SHA:0:7}"; attention "update-branch refused: $(echo "$OUT" | head -c 200)"; exit 3; fi
    else
      # no PR/remote: merge the base in locally
      if git merge -q --no-edit "$BASE_REF" >/tmp/sync-base.out 2>&1; then echo "SYNC before-merge result=merged base=${BASE_SHA:0:7} head=$(git rev-parse --short HEAD) (re-run verify --full)"
      else files="$(git diff --name-only --diff-filter=U | tr '\n' ',')"; git merge --abort; echo "SYNC before-merge result=conflict base=${BASE_SHA:0:7} head=${HEAD_SHA:0:7} files=${files%,}"; attention "merging $BASE_BRANCH in conflicts in: ${files%,}"; exit 3; fi
    fi ;;
esac
