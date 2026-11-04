# Third-party notices

The factory is MIT-licensed (see [LICENSE](LICENSE)). It copies only whole files from third parties, and each copied or adapted file carries a `license:` frontmatter line.

## Sources

<!-- One section per source: URL, pinned SHA, licence, copyright, files, and whether each file is copied or adapted. -->

### mattpocock/skills

- URL: https://github.com/mattpocock/skills
- Pinned SHA: `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d`
- Licence: MIT (text below)
- Copyright: Copyright (c) 2026 Matt Pocock
- Files:
  - `skills/grilling/SKILL.md`, copied from `skills/productivity/grilling/SKILL.md`. Its text is unchanged; the frontmatter gains `user-invocable: false` and a `license:` line.
  - `skills/wayfinder/SKILL.md`, adapted from `skills/engineering/wayfinder/SKILL.md`. Its map is on the factory's tracker, read from `tracker` in `.factory/config.json` and that tracker doc's Wayfinding operations, never `docs/agents/`; its destination is always a run list for `/factory`; research tickets go to the `factory:researcher` agent with the ticket's question, and their findings are committed to `.factory/maps/<slug>/research/` with no research branches; the prototype ticket type and the domain-modeling skill are dropped; a ticket's type is a `Type:` line, never a label. The frontmatter gains `allowed-tools` and a `license:` line.

## Licence texts

<!-- Each licence's full text, once. -->

### MIT (mattpocock/skills)

```
MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Ideas from

<!-- Projects whose ideas the factory uses without copying their text. -->

- [github/spec-kit](https://github.com/github/spec-kit) (MIT): `FR-###` and `SC-###` identifiers, and settled answers kept under `## Clarifications` / `### Session <date>`.
- [obra/superpowers](https://github.com/obra/superpowers) (MIT): a builder check that reads the spec cold, its questions sorted into answered, minor and the human's, and a hard gate before anything is built; the implementer's `DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT` statuses, leave to stop, and a fresh implementer on a stronger model once fix rounds stall; the code lens's missing, extra and misread, an implementer's account never lowering a finding, and fix rounds re-reviewed on their own diff; `review-package`'s Commits, Files changed and Diff sections.
- [coleam00/Archon](https://github.com/coleam00/Archon) (MIT): the implementer's standing rules (code over prose, a commit per outcome staged by name, checking only what changed, installs from the lockfile) and the `red_cause` vocabulary that decides whether a red costs a round.
- [wshobson/agents](https://github.com/wshobson/agents) (MIT): ship-mate's rule that the same failure twice escalates at once; only the review's P0 and P1 findings going to a fix round.
- [bmad-code-org/bmad-method](https://github.com/bmad-code-org/bmad-method) (MIT): an intent block frozen once the human approves it (`<frozen-after-approval>`); the plan as the implementer's only source of truth, with its `## Code map` and `## Open questions` headings and a budget of 900 to 1,600 tokens.
- [elayadesign/ai-design-skills](https://github.com/elayadesign/ai-design-skills) (MIT): `ui-craft`'s content honesty with visible placeholders, the states every control and data view has, motion on `transform` and `opacity` with a reduced-motion fallback, the 390 px check, nested radii, and state never shown by color alone.
- [pbakaus/impeccable](https://github.com/pbakaus/impeccable) (Apache-2.0): the spec's `surface: operate | persuade | read` line; the operate-surface checks `ui-craft`'s floor grew from; the UI lens's check 0, its `recapture | rebuild | fix | ship` dispositions, its critique rubric over Nielsen's heuristics with a floor, and the P0 to P3 severities.
- [emilkowalski/skills](https://github.com/emilkowalski/skills) (MIT): `ui-craft`'s motion limits, ease-out within 300 ms and never from `scale(0)`; the UI lens's break-ui and motion passes.
- [kunchenguid/no-mistakes](https://github.com/kunchenguid/no-mistakes) (MIT): a finding's `fix | ask | note` action, a missing one read as `ask`; anything the intent doesn't need as a `P2 ask`; expected values that don't come from the code under test; an implementer that never runs the full suite.
- [mattpocock/skills](https://github.com/mattpocock/skills) (MIT): the code lens's two axes in one pass, spec compliance and the repo's written standards first; tickets cut as vertical slices; the tracker docs' Wayfinding operations, and a local map as a folder of numbered tickets with `Status:` and `Blocked by:` lines whose frontier is the first open, unblocked, unclaimed one; the retro's kinds of proposal (a mechanical rule, a lesson, an index line, an ADR).
- [ski043/marshal-factory](https://github.com/ski043/marshal-factory) (no licence; ideas only): the triager's test that a request is ready when its acceptance check can be stated from the request alone; the recipe at `.factory/setup.json` with its `test`, `lint` and `typecheck` keys; evidence pinned to a commit; a merge decision computed from facts.
- [affaan-m/ecc](https://github.com/affaan-m/ecc) (MIT): `guard-paths` keeping a run off lint, CI and recipe config; setup's stack indicators and its dry-run proposal before anything is written; a bug's failing regression test committed before its fix; the researcher saying so when no similar code exists, never inventing a pattern; a `plugin.json` with no `agents` or `hooks` keys.
- [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill) (MIT): the UI lens judging what the captures show, never the builder's account of them.
- [rebelytics/one-skill-to-rule-them-all](https://github.com/rebelytics/one-skill-to-rule-them-all) (CC BY 4.0): the retro's proposals staged for the human, nothing applied until they accept it.
- [Andrej Karpathy's LLM wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) (no licence stated): `.factory/` as an index of what the project knows plus an append-only `log.md` whose lines start with fixed prefixes (`run:`, `escalation:`).
- [nvk/llm-wiki](https://github.com/nvk/llm-wiki) (MIT): agents reading `.factory/index.md` first instead of scanning the project.
- [dietrichgebert/ponytail](https://github.com/dietrichgebert/ponytail) (MIT): the `ponytail:` comment that marks a deliberate simplification in a script, its ceiling and the way past it.
