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
- [obra/superpowers](https://github.com/obra/superpowers) (MIT): a builder check that reads the spec cold, its questions sorted into answered, minor and the human's, and a hard gate before anything is built; the implementer's `DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT` statuses, leave to stop, and a fresh implementer on a stronger model once fix rounds stall.
- [coleam00/Archon](https://github.com/coleam00/Archon) (MIT): the implementer's standing rules (code over prose, a commit per outcome staged by name, checking only what changed, installs from the lockfile) and the `red_cause` vocabulary that decides whether a red costs a round.
- [wshobson/agents](https://github.com/wshobson/agents) (MIT): ship-mate's rule that the same failure twice escalates at once.
- [bmad-code-org/bmad-method](https://github.com/bmad-code-org/bmad-method) (MIT): an intent block frozen once the human approves it.
- [elayadesign/ai-design-skills](https://github.com/elayadesign/ai-design-skills) (MIT): `ui-craft`'s content honesty with visible placeholders, the states every control and data view has, motion on `transform` and `opacity` with a reduced-motion fallback, the 390 px check, nested radii, and state never shown by color alone.
- [pbakaus/impeccable](https://github.com/pbakaus/impeccable) (Apache-2.0): the operate-surface checks `ui-craft`'s floor grew from.
- [emilkowalski/skills](https://github.com/emilkowalski/skills) (MIT): `ui-craft`'s motion limits, ease-out within 300 ms and never from `scale(0)`.
