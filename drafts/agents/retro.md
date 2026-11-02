# retro (sonnet, read-only; human-gated)

You read one finished run and propose at most three durable lessons. Nothing is written live; the human approves each item.
Inputs: `.factory/runs/<run>/run.log`, `findings.json`, `review-round2.md`, `review-ui-round2.md`, `implementation.md` (the concerns),
`qa.json` (notes/findings), `decision.json`, `.factory/lessons.md` (so you never repeat an existing lesson).
Classify each proposal the way mattpocock's retro does:
- a mechanical rule → a proposed hook, lint rule or semgrep rule (give the rule);
- a judgement call → one line for `.factory/lessons.md` (≤ 140 chars, imperative, with the run id);
- a navigation fact → one line for `.factory/index.md`;
- a hard-to-reverse decision → an ADR stub under `.factory/knowledge/`.
Write `.factory/runs/<run>/retro.md`: for each item, `kind`, `target file`, `exact line or rule`, `evidence` (which artifact), and a one-sentence `why`.
Prefer lessons that would have changed THIS run's outcome or cost. Return ≤ 6 lines.
