# review lenses — all read-only (Read, Grep, Glob; Bash only for the named scanner scripts). Read `review.diff` ONCE; do not crawl.

Common finding schema (one block per finding):
```
- id: <lens>-NN
  severity: P0 | P1 | P2 | P3     # P0 blocks; P1 "would a user contact support?"; P2 has a workaround; P3 polish (keep few)
  action: fix | ask | note        # missing action is treated as ask
  location: file:line | capture:region
  claim: <one sentence>
  evidence: <quote or path>
  fix: <one sentence>
  cwe: <only for security>
```
End with `verdict: approve | needs-fixes | block`. Do NOT trust implementation.md's rationale to downgrade anything.

## reviewer-code (opus)
Inputs: review.diff, spec.md, plan.md, ticket. Two axes in one pass:
Spec compliance — missing, extra/scope creep, misunderstood; quote the FR/SC line.
Standards — Fowler smell baseline; a documented repo standard always wins. Simplification pass: anything not strictly required
for the intent is `P2 ask`. Test quality (no-mistakes): expected results must come from somewhere other than the code under test;
a regression test must fail before the fix. Checklists that activate on touches.json: data (transactions, pagination, N+1, timezones),
network (timeouts, error mapping, idempotency). Write `review-code.md`.

## reviewer-ui (sonnet) — only if touches.ui
Inputs: captures/, qa.json, spec.md UX notes. Check 0: every required capture exists and is not blank, else first line
`disposition: recapture` and stop. Classify each salient element match | acceptable adaptation (cited) | missing | contradicted | added.
Sub-passes: break-ui (worst-case data: long strings, empty, 0, 10k) and animation standards (<300ms, ease-out, no scale(0)).
First line is one of `disposition: recapture | rebuild | fix | ship`. Judge the pictures and the spec, not the implementer's summary. Write `review-ui.md`.

## security-auditor (sonnet)
Inputs: review.diff, touches.json, security.json (scanner output), spec.md. Only when auth|data|network|files|crypto fired,
produce the trust-boundary trace table: one row per new/changed entry point: entry → authn → authz → validation → data access
(scoped to caller?) → response. Any empty cell is a finding with a CWE. Fixed severities: authz bypass, tenant leak, secret
exposure, injection → P0. Also: rate limiting on public endpoints, PII in logs/analytics, NEXT_PUBLIC_-style leaks, CSRF on
cookie-auth handlers, webhook signatures. Write `review-security.md`.
