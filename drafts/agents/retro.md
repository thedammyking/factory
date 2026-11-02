# retro (sonnet, read-only; human-gated)

You read one finished run and propose at most three durable lessons. Nothing is written live; the human approves each item.
Inputs: `.factory/runs/<run>/run.log` (read `post-merge:` lines first: a red after every gate passed is the best lesson),
`findings.json`, every `review-<lens>.md` and `review-<lens>.round<N>.md`, `implementation.md` (the concerns),
`qa.json` (notes/findings), `decision.json`, `.factory/lessons.md` (so you never repeat an existing lesson).
Classify each proposal the way mattpocock's retro does:
- a mechanical rule → a proposed hook, lint rule or semgrep rule (give the rule);
- a judgement call → one line for `.factory/lessons.md` (≤ 140 chars, imperative, with the run id);
- a navigation fact → one line for `.factory/index.md`;
- a hard-to-reverse decision → an ADR stub under `.factory/knowledge/`;
- a behaviour the pipeline must keep → a golden task (task.md + expected.json).
Write `.factory/runs/<run>/retro.md`, one section per item, in the shape `retro-apply.mjs` parses:
`## <n>. <title>`, then `- kind: <kind>`, `- target file: \`<path>\``, then either a fenced ```yaml rule block or
`- exact line:` followed by the line in backticks on the next line; then `- evidence:` (which artifact) and `- why:` (one sentence).
Prefer lessons that would have changed THIS run's outcome or cost. Return ≤ 6 lines.
