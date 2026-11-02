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
Inputs: review.diff, spec.md, plan.md, design-ref.md when present, ticket. Two axes in one pass:
Spec compliance — missing, extra/scope creep, misunderstood; quote the FR/SC line.
Standards — Fowler smell baseline; a documented repo standard always wins. Simplification pass: anything not strictly required
for the intent is `P2 ask`. Test quality (no-mistakes): expected results must come from somewhere other than the code under test;
a regression test must fail before the fix. Checklists that activate on touches.json: data (transactions, pagination, N+1, timezones),
network (timeouts, error mapping, idempotency).
Two rules from the touch mask and the commit list:
- `api_contract` fired but neither `auth` nor `data` did: each new endpoint is a `P1 ask` (is it meant to be public and stateless?).
- `# Commits` in review.diff shows one commit for a plan with several tasks: `P2 note` (the commit-as-you-go habit failed;
  recovery depends on it).
When design-ref.md names a component library, a new component in the diff that does the job of one of its components is
`P1 fix` (build it from the library's); one that design-ref.md lists as new is not a finding.
Write `review-code.md`.

## reviewer-ui (sonnet) — only if touches.ui
Inputs: captures/ (with `states.json`: per-state `overflow` and `axe`), qa.json, spec.md UX notes, design-ref.md when
present. Check 0: every required capture exists and is not blank, else first line `disposition: recapture` and stop.
Classify each salient element against design-ref.md and the spec: match | acceptable adaptation (cited) | missing |
contradicted | added.
Sub-passes: break-ui (worst-case data: long strings, empty, 0, 10k) and animation standards (<300ms, ease-out, no scale(0),
only `transform`/`opacity` animated, a `prefers-reduced-motion` fallback).
Floor findings (the `ui-craft` floor, judged from the captures and the diff):
- A price, count, statistic, testimonial or logo that is not in spec.md or the repo is invented: `P1 fix`, replace it with a
  visible `{{placeholder}}`. An error that does not say what failed and what to do next: `P2 fix`.
- `overflow: true` at a mobile width, or a `persuade` surface whose primary action is not in the first 390 px screen: `P1 fix`.
- axe violations: serious or critical `P1 fix`, the rest `P2`. `axe: "missing"` is one `P2 note`, never a pass.
- State shown by color alone, gradient text failing contrast at its lightest end, an inner radius that is not the outer
  radius minus the gap (gap < 32 px), an `href="#"`, no current item in the nav: severity by the schema's P-levels.
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
(called as the wrong user or tenant, expecting 403 or 404) is a `P1 ask`.
Checklists that activate on touches.json. An unmet item is a finding with its CWE; the fixed severities above still apply:
- api_contract: a method the route does not serve gets 405, an unsupported request content-type 415; the response sets its
  own content-type; error bodies are generic, with no stack trace, SQL or internal path (CWE-209); no credential or token in
  a URL or query string (CWE-598); where the app sets headers: `X-Powered-By` off, `nosniff`, frame-ancestors, a CSP.
  GraphQL: introspection off in production, a depth or cost limit (CWE-770).
- data: a request body written whole (spread, `Object.assign`, `data: body`) instead of through an allowlist is mass
  assignment (CWE-915), an authz bypass when it can set a role, owner, tenant or price; a price, total, quantity or discount
  taken from the client (CWE-602); a single-use thing (coupon, vote, refund, invite) guarded by read-then-write instead of
  a unique constraint or a transaction (CWE-362).
- auth: OAuth `redirect_uri` matched exactly against a server-side allowlist, no `response_type=token`, `state` generated and
  checked (CWE-601, CWE-352); reset and one-time codes random, single-use, expiring and never returned or logged, the reset
  link's host from config and never the `Host` header (CWE-640); sessions revoked on logout and password change (CWE-613);
  login, reset and code endpoints limited on a key the client cannot rotate: not a raw `X-Forwarded-For`, not
  `trust proxy: true` (CWE-307); a path-prefix guard that normalises paths differently from the router (case, trailing
  slash, encoding) instead of a guard on the route (CWE-863).
- files: an extension allowlist plus a content check, SVG and HTML treated as active content, a size cap, EXIF stripped from
  images served back, uploads served from another origin or as attachments (CWE-434); XML parsed with external entities and
  entity expansion off (CWE-611, CWE-776).
When security.json or semgrep-project.json already holds a semgrep hit for one of these (the starter rules catch mass
assignment, `trust proxy: true` and stack traces in responses), cite it instead of raising a second finding.
Write `review-security.md`.
