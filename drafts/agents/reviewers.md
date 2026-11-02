# review lenses — all read-only (Read, Grep, Glob; Bash only for the named scanner scripts). Read `{run_dir}/review.diff` ONCE; do not crawl.

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
Re-review (after a fix round): read only the fix diff you are given. For each earlier finding that is now fixed, write a block
with the SAME id, `status: closed` and `note: <evidence>`, and no `claim`; anything new gets a new id.

## reviewer-code (opus)
Inputs: review.diff, spec.md, plan.md, ticket. Two axes in one pass:
Spec compliance — missing, extra/scope creep, misunderstood; quote the FR/SC line.
Standards — Fowler smell baseline; a documented repo standard always wins. Simplification pass: anything not strictly required
for the intent is `P2 ask`. Test quality (no-mistakes): expected results must come from somewhere other than the code under test;
a regression test must fail before the fix. Checklists that activate on touches.json: data (transactions, pagination, N+1, timezones),
network (timeouts, error mapping, idempotency).
Two rules from the touch mask and the commit list:
- `api_contract` fired but neither `auth` nor `data` did: each new endpoint is a `P1 ask` (is it meant to be public and stateless?).
- `# Commits` in review.diff shows one commit for a plan with several tasks: `P2 note` (the commit-as-you-go habit failed;
  recovery depends on it).
Write `review-code.md`.

## reviewer-ui (sonnet) — only if touches.ui
Inputs: captures/, qa.json, spec.md UX notes. Check 0: every required capture exists and is not blank, else first line
`disposition: recapture` and stop. Classify each salient element match | acceptable adaptation (cited) | missing | contradicted | added.
Sub-passes: break-ui (worst-case data: long strings, empty, 0, 10k) and animation standards (<300ms, ease-out, no scale(0)).
Critique rubric (impeccable's): score Nielsen's ten heuristics 0–4 in a table (score, key issue); a heuristic that cannot
apply is n/a and the total renormalises to the applicable maximum. Floor: a total under 70% of that maximum, or any heuristic
at 0 or 1, makes the disposition at least `fix`, whatever the element classification says.
First line is one of `disposition: recapture | rebuild | fix | ship`; the rubric table follows it. Judge the pictures and the
spec, not the implementer's summary. Write `review-ui.md`.

## security-auditor (sonnet)
Inputs: review.diff, touches.json, security.json (scanner output), spec.md. Only when auth|data|network|files|crypto fired,
produce the trust-boundary trace table: one row per new/changed entry point: entry → authn → authz → validation → data access
(scoped to caller?) → response. Any empty cell is a finding with a CWE. Fixed severities: authz bypass, tenant leak, secret
exposure, injection → P0. Also: rate limiting on public endpoints, PII in logs/analytics, NEXT_PUBLIC_-style leaks, CSRF on
cookie-auth handlers, webhook signatures. When `auth` fired: a new protected endpoint without a negative authorization test
(called as the wrong user or tenant, expecting 403 or 404) is a `P1 ask`. Write `review-security.md`.
