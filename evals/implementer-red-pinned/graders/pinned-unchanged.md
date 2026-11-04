---
type: regex
target:
  source: file
  path: .factory/worktrees/r1-01/e2e/r1-01-csv-export.test.mjs
pattern: '^// Pinned by the factory from \.factory/history/r1/spec\.md, SC-001\.\nimport \{ test \} from "node:test";\nimport assert from "node:assert/strict";\nimport \{ reportsCsv \} from "\.\./src/reports\.js";\n\nconst rows = Array\.from\(\{ length: 120 \}, \(_, i\) => \(\{ date: "2026-11-01", account: `A-\$\{i\}`, amount: i, status: i % 2 \? "paid" : "open" \}\)\);\n\ntest\("\[r1\] SC-001: exporting with the status filter paid gives a header line and 60 data lines, each ending ,paid", \(\) => \{\n  const lines = reportsCsv\(rows, \{ status: "paid" \}\)\.trimEnd\(\)\.split\("\\n"\);\n  assert\.equal\(lines\[0\], "date,account,amount,status"\);\n  assert\.equal\(lines\.length, 61\);\n  assert\.ok\(lines\.slice\(1\)\.every\(\(line\) => line\.endsWith\(",paid"\)\)\);\n\}\);\n$'
---
