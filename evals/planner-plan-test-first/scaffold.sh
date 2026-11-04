set -e
git init -q -b main
git config user.name eval
git config user.email eval@example.com
git config commit.gpgsign false
mkdir -p .factory/runs/r1/tickets src test

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

cat > .factory/index.md <<'EOF'
# Index

## Apps

- `api`: the reports API, in `src/`, tested with `node --test` from `test/`.

## Memory

- `.factory/log.md`: one line per event of every run.
- `.factory/lessons.md`: lessons from past runs.
EOF

cat > .factory/lessons.md <<'EOF'
# Lessons

- lesson: `node --test` runs only the files under `test/`, so a test written anywhere else never runs.
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

cat > .factory/runs/r1/prompt.md <<'EOF'
Add a CSV export of the reports table.
EOF

cat > .factory/runs/r1/spec.md <<'EOF'
---
surface: operate
---

# CSV export of the reports

<frozen-after-approval>
Finance staff reconcile the monthly reports by copying the reports table by hand. They get a CSV of exactly the rows their filters match, so reconciling takes minutes instead of an hour.
</frozen-after-approval>

## Goal
The reports API can return every row the current filters match as CSV, which a later ticket offers as a download.

## Non-goals
- Excel or PDF files.

## Anti-goals
- An export that silently drops the rows past the first page.

## User stories
- **P1** As a finance user, I want the filtered reports as a CSV, so that I can reconcile them in my spreadsheet. Shown alone by: SC-001.

## Functional requirements
- **FR-001**: The export holds every row matching the current filters, across all pages, with the columns date, account, amount and status, in the table's order.
- **FR-002**: The first line is the header `date,account,amount,status`.

## Success criteria
- **SC-001** (profile: default, live-safe: yes): With 120 rows of which 60 have the status `paid`, exporting with the status filter `paid` gives a header line and 60 data lines, each ending `,paid`.

## Implementation decisions
- The CSV is built from the same filter the table uses.

## Testing decisions
- Unit tests through the exported function, with `node --test`.

## Out of scope
- The download button, which is ticket 02.

## Clarifications
### Session 2026-11-04
- Q: Which rows does the export hold? → A: Every row the filters match, not only the page on screen.

## Left to the builder
- nothing
EOF

cat > .factory/runs/r1/research.md <<'EOF'
# Research: a CSV export of the reports table

## Codebase
- `src/reports.js:1`: `reportRows(rows, { status, page, perPage })` filters by status, then returns one page of 50. The export needs the filter without the paging.
- `test/reports.test.js:7`: the existing unit test, run by `node --test` (the recipe's `test` check).

## Packages
- none

## Risks and unknowns
- An account name holding a comma would break a naive join.

Status: ok
EOF

cat > .factory/runs/r1/grill.md <<'EOF'
## Clarifications
### Session 2026-11-04
- Q: Which rows does the export hold? → A: Every row the filters match, not only the page on screen.
EOF

cat > .factory/runs/r1/tickets/01-csv-of-matching-rows.md <<'EOF'
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

cat > .factory/runs/r1/tickets/02-export-button.md <<'EOF'
# 02: Export button

Status: ready-for-agent
Blocked by: 01

## Goal
The reports page offers the CSV as a download.

## Covers
- [ ] SC-001: the download holds what `reportsCsv` returns.

## Interfaces
- Consumes: `reportsCsv(rows, { status })` from ticket 01.
- Produces: nothing later tickets use.

## Notes
- none
EOF

git add -A
git commit -qm "Page the reports"
