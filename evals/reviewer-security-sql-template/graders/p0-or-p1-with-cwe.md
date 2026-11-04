---
type: regex
target:
  source: file
  path: .factory/runs/r1/review-security.md
pattern: '- id: security-\d+\n[ \t]+severity: P[01]\b[^\n]*(?:\n[ \t]+[^\n]*)*?\n[ \t]+cwe: CWE-\d+'
---
