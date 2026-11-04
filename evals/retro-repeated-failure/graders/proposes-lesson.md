---
type: regex
target:
  source: file
  path: .factory/runs/retro/retro.md
pattern: '^## [1-3]\. [^\n]*\n(?:(?!^## )[\s\S])*?^- kind: lesson[ \t]*\n(?:(?!^## )[\s\S])*?^```[a-z]*\n[^\n]*\b(cents?|rounding|Math\.round|applyRate|money\.js|floats?|floating|integers?)\b'
flags: mi
---
