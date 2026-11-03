---
type: regex
target:
  source: file
  path: .factory/runs/r1/triage.md
# one to three JSON strings in the questions array
pattern: '"questions"\s*:\s*\[\s*"(?:[^"\\]|\\.)*"(?:\s*,\s*"(?:[^"\\]|\\.)*"){0,2}\s*\]'
---
