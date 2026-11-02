#!/usr/bin/env bash
# review-package.sh <base_sha> -> review.diff (product code + recipe; factory bookkeeping excluded), -U10, with commits + files sections
set -eu; ROOT="$PWD"; while [ ! -d "$ROOT/.factory" ]; do [ "$ROOT" = / ] && { echo "no .factory/ above $PWD" >&2; exit 2; }; ROOT="$(dirname "$ROOT")"; done; RUN="$ROOT/.factory/runs/$(cat "$ROOT/.factory/runs/ACTIVE")"; BASE="$1"
# Everything in the repo except factory bookkeeping and plugin-owned files (an exclude always beats an include in git, so the
# recipe stays in by excluding the bookkeeping paths one by one rather than all of .factory/).
P=(. ':(exclude).factory/runs' ':(exclude).factory/history' ':(exclude).factory/log.md' ':(exclude).factory/tickets' ':(exclude).factory/scripts' ':(exclude).factory/agents')
L=(':(exclude)pnpm-lock.yaml' ':(exclude)package-lock.json' ':(exclude)yarn.lock' ':(exclude)bun.lock')
{ echo "# Commits $BASE..HEAD"; git -C "$ROOT" log --oneline "$BASE..HEAD" -- "${P[@]}"
  echo; echo "# Files changed"; git -C "$ROOT" diff --stat "$BASE..HEAD" -- "${P[@]}" "${L[@]}"
  echo; echo "# Diff"; git -C "$ROOT" diff -U10 "$BASE..HEAD" -- "${P[@]}" "${L[@]}"; } > "$RUN/review.diff"
echo "review.diff $(wc -l < "$RUN/review.diff") lines"
