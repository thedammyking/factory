---
type: regex
target:
  source: file
  path: .factory/runs/r1/review-code.md
pattern: '- id: code-\d+\n[ \t]+severity: P[01]\b[^\n]*(?:\n[ \t]+[^\n]*)*?\n[ \t]+location: [^\n]*src/checkout\.js'
---
