---
type: regex
target:
  source: file
  path: .factory/runs/r1/research.md
pattern: '^## Fact:[^\n]*\n(?:(?!^## )[\s\S])*?src/uploads/limits\.js:4\b'
flags: m
---
