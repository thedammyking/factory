set -e
# On macOS the eval sandbox can't run /usr/bin/git, an xcrun stub whose cache lies outside it, and the
# agent's shell picks that stub. Point the shell at the real binary, in the eval run's own home only.
case "$HOME" in */e-*/home)
  if [ "$PWD" = "$HOME/cwd" ] && command -v xcrun >/dev/null; then
    printf 'git() { "%s" "$@"; }\n' "$(xcrun -f git)" | tee -a "$HOME/.zshenv" >> "$HOME/.bashrc"
  fi ;;
esac
git init -q -b main
git config user.name eval
git config user.email eval@example.com
git config commit.gpgsign false
mkdir -p .factory src test e2e

cat > .gitignore <<'EOF'
.factory/runs/
.factory/worktrees/
.factory/env.local
EOF

cat > .factory/config.json <<'EOF'
{ "branching": { "model": "trunk", "main": "main", "prefixes": { "feature": "feature/", "bugfix": "bugfix/", "hotfix": "hotfix/" } } }
EOF

cat > .factory/setup.json <<'EOF'
{ "apps": [{ "name": "api", "type": "backend", "path": ".", "checks": { "test": "node --test" } }], "pinned": ["e2e"] }
EOF

cat > package.json <<'EOF'
{ "name": "reports", "type": "module", "scripts": { "test": "node --test" } }
EOF

cat > src/reports.js <<'EOF'
export function reportRows(rows, { status, page = 1, perPage = 50 } = {}) {
  const matching = status ? rows.filter((r) => r.status === status) : rows;
  return matching.slice((page - 1) * perPage, page * perPage);
}
EOF

cat > test/reports.test.js <<'EOF'
import { test } from "node:test";
import assert from "node:assert/strict";
import { reportRows } from "../src/reports.js";

const rows = Array.from({ length: 120 }, (_, i) => ({ date: "2026-11-01", account: `A-${i}`, amount: i, status: i % 2 ? "paid" : "open" }));

test("reportRows pages the matching rows", () => {
  assert.equal(reportRows(rows, { status: "paid" }).length, 50);
  assert.equal(reportRows(rows, { status: "paid", page: 2 }).length, 10);
});
EOF

# The pinned test qa wrote from SC-001, red until the export exists.
cat > e2e/r1-01-csv-export.test.mjs <<'EOF'
// Pinned by the factory from .factory/history/r1/spec.md, SC-001.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reportsCsv } from "../src/reports.js";

const rows = Array.from({ length: 120 }, (_, i) => ({ date: "2026-11-01", account: `A-${i}`, amount: i, status: i % 2 ? "paid" : "open" }));

test("[r1] SC-001: exporting with the status filter paid gives a header line and 60 data lines, each ending ,paid", () => {
  const lines = reportsCsv(rows, { status: "paid" }).trimEnd().split("\n");
  assert.equal(lines[0], "date,account,amount,status");
  assert.equal(lines.length, 61);
  assert.ok(lines.slice(1).every((line) => line.endsWith(",paid")));
});
EOF

git add -A
git commit -qm "Page the reports"

# The run's worktree with its run dir, and the ticket's worktree cut from it, as run-state and run-stage lay them out.
git worktree add -q --detach .factory/worktrees/r1
RUN="$PWD/.factory/worktrees/r1/.factory/runs/r1"
mkdir -p "$RUN/tickets/01"
cat > "$RUN/state.json" <<EOF
{ "id": "r1", "request": "Add a CSV export of the reports table.", "stage": "implement:01", "route": "build", "base_branch": "main",
  "base_sha": "$(git rev-parse HEAD)", "worktree": "$PWD/.factory/worktrees/r1", "run_dir": "$RUN", "dispatches": [], "stages_done": [],
  "created_at": "2026-11-04T09:00:00.000Z" }
EOF
git worktree add -q -b factory/r1/01 .factory/worktrees/r1-01

cat > "$RUN/tickets/01-csv-of-matching-rows.md" <<'EOF'
# 01: CSV of every matching row

Status: in-progress
Blocked by: none

## Goal
The reports module returns the CSV of every row the filters match, across all pages.

## Covers
- [ ] FR-001, FR-002, SC-001: the CSV holds the header and every matching row, in order.

## Interfaces
- Consumes: the rows and the status filter `reportRows` already takes.
- Produces: `reportsCsv(rows, { status })`, returning the CSV text, for ticket 02's download.

## Notes
- none
EOF

cat > "$RUN/tickets/01/plan.md" <<'EOF'
---
status: ready
ticket: 01-csv-of-matching-rows
context:
  - src/reports.js
  - test/reports.test.js
  - e2e/r1-01-csv-export.test.mjs
---

# Plan 01: CSV of every matching row

<frozen-after-approval>
Finance staff reconcile the monthly reports by copying the reports table by hand. They get a CSV of exactly the rows their filters match, so reconciling takes minutes instead of an hour.
</frozen-after-approval>

## Code map
- `src/reports.js` (change): add `reportsCsv(rows, { status })`, using the same status filter as `reportRows` and no paging.
- `test/reports.test.js` (change): unit tests for `reportsCsv`.

## Interfaces
- Consumes: `reportRows(rows, { status, page, perPage })` at `src/reports.js:1`, whose filter the export shares.
- Produces: `reportsCsv(rows, { status })`, returning the CSV text: the header `date,account,amount,status`, then one line per matching row, in the table's order, each line ending in a newline.

## Tasks
1. **Given** 120 rows of which 60 are `paid` **When** `reportsCsv(rows, { status: "paid" })` runs **Then** it returns the header and 60 lines, each ending `,paid`. Test first: `test/reports.test.js`, failing before `src/reports.js` changes.
2. **Given** a status filter that matches no row **When** `reportsCsv` runs **Then** it returns the header line alone. Test first: `test/reports.test.js`.

The pinned test `e2e/r1-01-csv-export.test.mjs` checks SC-001. It is the factory's, in a pinned directory: it passes once the export is right, and it is never edited.

## Verification
- `node --test` → every test passes, `e2e/r1-01-csv-export.test.mjs` included: 0 failures.

## Open questions
- none
EOF
