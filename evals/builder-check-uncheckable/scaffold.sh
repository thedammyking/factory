set -e
git init -q -b main
git config user.name eval
git config user.email eval@example.com
git config commit.gpgsign false
mkdir -p .factory/runs/r1 src

cat > .gitignore <<'EOF'
.factory/runs/
.factory/worktrees/
.factory/env.local
EOF

cat > .factory/config.json <<'EOF'
{ "branching": { "model": "trunk", "main": "main", "prefixes": { "feature": "feature/", "bugfix": "bugfix/", "hotfix": "hotfix/" } } }
EOF

cat > .factory/setup.json <<'EOF'
{ "apps": [{ "name": "web", "type": "web", "path": ".", "checks": { "test": "node --test" } }] }
EOF

cat > src/reports.js <<'EOF'
export function reportRows(rows, { status, page = 1, perPage = 50 } = {}) {
  const matching = status ? rows.filter((r) => r.status === status) : rows;
  return matching.slice((page - 1) * perPage, page * perPage);
}
EOF

cat > .factory/runs/r1/spec.md <<'EOF'
---
surface: operate
---

# CSV export of the reports table

<frozen-after-approval>
Finance staff reconcile the monthly reports by copying the reports table by hand. They get a one-click CSV of exactly the rows their filters show, so reconciling takes minutes instead of an hour.
</frozen-after-approval>

## Goal
The reports page gains an Export CSV button that downloads every row the current filters match.

## Non-goals
- Excel or PDF files.
- Scheduled or emailed exports.

## Anti-goals
- An export that silently drops the rows past the first page.

## User stories
- **P1** As a finance user, I want the filtered reports table as a CSV file, so that I can reconcile it in my spreadsheet. Shown alone by: SC-001.

## Functional requirements
- **FR-001**: The reports page at `/reports` shows an "Export CSV" button above the table.
- **FR-002**: The export holds every row matching the current filters, across all pages, with the columns date, account, amount and status, in the table's order.
- **FR-003**: The file is named `reports-<YYYY-MM-DD>.csv`, with today's date.

## Success criteria
- **SC-001** (profile: default, live-safe: yes): On `/reports` with the status filter set to `paid`, clicking "Export CSV" downloads `reports-<today>.csv`, whose header row is `date,account,amount,status` and whose every data row has the status `paid`.
- **SC-002** (profile: default, live-safe: yes): On `/reports` with 120 matching rows shown 50 to a page, clicking "Export CSV" downloads a file with 120 data rows.
- **SC-003** (profile: default, live-safe: yes): The export feels fast.

## Implementation decisions
- The server builds the CSV from the same query the table uses.

## Testing decisions
- One end-to-end test per criterion, through the reports page.

## Out of scope
- Changing which columns the table shows.

## Clarifications
### Session 2026-11-04
- Q: Which rows does the export hold? → A: Every row the current filters match, not only the page on screen.
- Q: Which formats? → A: CSV only.

## Left to the builder
- The button's icon.
EOF

git add -A
git commit -qm "Page the reports table"
