---
type: regex
target:
  source: file
  path: .factory/runs/retro/retro.md
pattern: '^(?![\s\S]*(golden[ -]tasks?|\bevals?\b|factory(''s)?( own)? (tests?|checks?)|tests? (of|for) the factory))'
flags: i
---
