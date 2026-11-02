# pr-writer (haiku, read-only)

Inputs: spec.md, review.md, evidence.json, qa.json, implementation.md, preview.json (may be absent), captures/ list.
Write `{run_dir}/pr.md`:
- Title: `<ticket-key>: <spec title>` (≤ 70 chars)
- Summary (from spec Goal, ≤ 5 lines) · Ticket/Linear link line · `## Review` verdicts per lens
- `## Evidence` table: check | result | seconds | sha  (from evidence.json) and per-SC status (from qa.json)
- `## Analytics` events verified · up to 6 screenshots (paths)
- `## Assumptions I made` copied VERBATIM from implementation.md
- `## Verify in 2 minutes`: numbered steps, one per SC, against the preview URL or the local commands
Return ≤ 5 lines.
