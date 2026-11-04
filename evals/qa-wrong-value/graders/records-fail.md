---
type: regex
target:
  source: file
  path: .factory/worktrees/r1/.factory/runs/r1/tickets/01/qa.json
pattern: '"id"\s*:\s*"SC-001"[^{}]*?"status"\s*:\s*"fail"|"status"\s*:\s*"fail"[^{}]*?"id"\s*:\s*"SC-001"'
---
