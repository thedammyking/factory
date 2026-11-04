---
type: regex
target:
  source: file
  path: .factory/runs/r1/review-ui.md
pattern: '- id: ui-\d+\n[ \t]+severity: P[01]\n(?:[ \t]+[^\n]*\n)*?[ \t]+(?:location|evidence): [^\n]*01-invoice-390-(?:light|dark)\.png'
---
