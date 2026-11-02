#!/usr/bin/env bash
# pr-open.sh [--run <id>] — open (or update) the run's draft PR from pr.md. REST only: Claude Code sessions cannot use
# GitHub GraphQL, so `gh pr create/list/view` are avoided in favour of `gh api repos/...`.
# Writes <run>/pr.json {number,url,head,base,labels} and prints one line: PR <created|updated> #<n> <url>
set -euo pipefail
ROOT="$PWD"; while [ ! -d "$ROOT/.factory" ]; do [ "$ROOT" = / ] && { echo "no .factory/ above $PWD" >&2; exit 2; }; ROOT="$(dirname "$ROOT")"; done  # the project, not the plugin
LIB="$(cd "$(dirname "$0")" && pwd)/lib.mjs"
RUN="$(cd "$ROOT" && node "$LIB" run-dir "$@")"  # the run dir lives in the main checkout
REPO="$(git -C "$ROOT" remote get-url origin | sed -E 's#.*github.com[:/]##; s#\.git$##')"  # not `gh repo view`: that is GraphQL
STATE="$RUN/state.json"
HEAD_BRANCH="$(git -C "$ROOT" branch --show-current)"
BASE_BRANCH="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).target_branch||"develop")' "$STATE")"
DECISION="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).decision)}catch{console.log("needs-human")}' "$RUN/decision.json")"
TITLE="$(sed -n '1s/^# //p' "$RUN/pr.md")"
# Body = pr.md minus its title line, plus the attribution lines the current session requires (lib.trailer: exported, or
# recorded in state.json by the orchestrator; none recorded refuses, empty means the session requires none).
PR_TRAILER="$(cd "$ROOT" && node "$LIB" trailer pr "$@")"
BODY="$(sed '1d' "$RUN/pr.md")

$PR_TRAILER"
LABELS=("factory"); [ "$DECISION" = "merge" ] && LABELS+=("factory-merge") || LABELS+=("needs-human")

ensure_label() { gh api -X GET "repos/$REPO/labels/$1" >/dev/null 2>&1 || gh api -X POST "repos/$REPO/labels" -f name="$1" -f color="$2" -f description="$3" >/dev/null; }
ensure_label factory "5319e7" "opened by the software factory"
ensure_label needs-human "d93f0b" "factory stopped: a human must decide"
ensure_label factory-merge "0e8a16" "factory: all hard facts passed"

git -C "$ROOT" push -q -u origin "$HEAD_BRANCH"
EXISTING="$(gh api "repos/$REPO/pulls?head=${REPO%%/*}:$HEAD_BRANCH&state=open" -q '.[0].number' 2>/dev/null || true)"
if [ -n "$EXISTING" ]; then
  NUM="$EXISTING"; ACTION=updated
  gh api -X PATCH "repos/$REPO/pulls/$NUM" -f title="$TITLE" -f body="$BODY" >/dev/null
else
  NUM="$(gh api -X POST "repos/$REPO/pulls" -f title="$TITLE" -f head="$HEAD_BRANCH" -f base="$BASE_BRANCH" -f body="$BODY" -F draft=true -q .number)"; ACTION=created
  # first comment = the attention file (what the human must decide), when present
  [ -s "$RUN/attention.md" ] && gh api -X POST "repos/$REPO/issues/$NUM/comments" -f body="$(cat "$RUN/attention.md")
<!-- factory -->" >/dev/null
fi
gh api -X PUT "repos/$REPO/issues/$NUM/labels" --input <(printf '{"labels":%s}' "$(printf '%s\n' "${LABELS[@]}" | node -e 'console.log(JSON.stringify(require("fs").readFileSync(0,"utf8").trim().split("\n")))')") >/dev/null
URL="https://github.com/$REPO/pull/$NUM"
DRAFT="$(gh api "repos/$REPO/pulls/$NUM" -q .draft 2>/dev/null || echo true)"
printf '{"number":%s,"url":"%s","head":"%s","base":"%s","labels":%s,"draft":%s}\n' "$NUM" "$URL" "$HEAD_BRANCH" "$BASE_BRANCH" "$(printf '%s\n' "${LABELS[@]}" | node -e 'console.log(JSON.stringify(require("fs").readFileSync(0,"utf8").trim().split("\n")))')" "$DRAFT" > "$RUN/pr.json"
echo "PR $ACTION #$NUM $URL labels=${LABELS[*]}"
