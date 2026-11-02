#!/usr/bin/env bash
# review-package.sh <base_sha> -> review.diff (product code + recipe; factory bookkeeping excluded), -U10, with commits + files sections
set -eu; ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; RUN="$ROOT/.factory/runs/$(cat "$ROOT/.factory/runs/ACTIVE")"; BASE="$1"
{ echo "# Commits $BASE..HEAD"; git -C "$ROOT" log --oneline "$BASE..HEAD" -- apps .factory/setup.json package.json pnpm-workspace.yaml .gitignore
  echo; echo "# Files changed"; git -C "$ROOT" diff --stat "$BASE..HEAD" -- apps .factory/setup.json package.json pnpm-workspace.yaml .gitignore ':(exclude)pnpm-lock.yaml'
  echo; echo "# Diff"; git -C "$ROOT" diff -U10 "$BASE..HEAD" -- apps .factory/setup.json package.json pnpm-workspace.yaml .gitignore ':(exclude)pnpm-lock.yaml'; } > "$RUN/review.diff"
echo "review.diff $(wc -l < "$RUN/review.diff") lines"
