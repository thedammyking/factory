set -e
git init -q -b main
git config user.name eval
git config user.email eval@example.com
git config commit.gpgsign false
mkdir -p .factory src

cat > .gitignore <<'EOF'
.factory/runs/
.factory/worktrees/
.factory/env.local
EOF

cat > .factory/config.json <<'EOF'
{ "branching": { "model": "trunk", "main": "main", "prefixes": { "feature": "feature/", "bugfix": "bugfix/", "hotfix": "hotfix/" } } }
EOF

cat > .factory/setup.json <<'EOF'
{ "apps": [{ "name": "web", "type": "web", "path": ".", "dev": "npx vite --port {port:web}", "health": "http://localhost:{port:web}/", "checks": { "test": "node --test" } }] }
EOF

cat > package.json <<'EOF'
{ "name": "billing", "type": "module", "scripts": { "dev": "vite", "test": "node --test" } }
EOF

cat > src/invoice.css <<'EOF'
:root { --bg: #ffffff; --fg: #111827; --muted: #4b5563; --line: #e5e7eb; --accent: #1d4ed8; --on-accent: #ffffff; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #0b1220; --fg: #f3f4f6; --muted: #9ca3af; --line: #1f2a44; --accent: #60a5fa; --on-accent: #0b1220; }
}
body { margin: 0; font-family: Helvetica, Arial, sans-serif; background: var(--bg); color: var(--fg); }
main { padding: 24px; max-width: 720px; }
.label { color: var(--muted); font-size: 14px; line-height: 20px; }
.amount { font-size: 40px; font-weight: 700; margin: 24px 0 4px; }
.pay { background: var(--accent); color: var(--on-accent); border: 0; border-radius: 8px; padding: 14px 20px; font-size: 16px; font-weight: 600; min-height: 48px; margin-top: 24px; }
EOF

cat > src/InvoiceHeader.jsx <<'EOF'
export function InvoiceHeader({ invoice }) {
  return (
    <header>
      <div className="label">Invoice {invoice.number}</div>
      <div className="label">Due {invoice.dueDate}</div>
    </header>
  );
}
EOF

git add -A
git commit -qm "Show the invoice page"

# The run's change: the customer's name as the page's heading, kept to one line whatever its length.
git checkout -q -b feature/invoice-customer

cat > src/InvoiceHeader.jsx <<'EOF'
export function InvoiceHeader({ invoice }) {
  return (
    <header>
      <div className="label">Invoice {invoice.number}</div>
      <h1 className="customer">{invoice.customer.name}</h1>
      <div className="label">Due {invoice.dueDate}</div>
    </header>
  );
}
EOF

cat >> src/invoice.css <<'EOF'
.customer { font-size: 28px; line-height: 36px; margin: 4px 0; white-space: nowrap; }
EOF

git add -A
git commit -qm "Name the customer on the invoice page"

# The run dir as the review stage leaves it: the spec, the ticket's plan, the touches, review.diff in review-package's
# sections, and the captures capture-states.mjs took of the plan's one state, with their states.json and axe.json.
RUN=.factory/runs/r1
mkdir -p "$RUN/tickets/01" "$RUN/captures"

cat > "$RUN/spec.md" <<'EOF'
---
surface: operate
---

# The customer's name on the invoice page

<frozen-after-approval>
Accounts staff open an invoice while a customer is on the phone, and today they check the customer by the invoice number alone. The page names the customer at the top, so they know at a glance that they have the right invoice.
</frozen-after-approval>

## Goal
The invoice page shows the customer's name as its heading, above the due date.

## Non-goals
- Editing the customer from the invoice page.

## Anti-goals
- An invoice page that can't be read on a phone.

## Functional requirements
- **FR-001**: The invoice page at `/invoices/<number>` shows the customer's full name as its heading, between the invoice number and the due date.

## Success criteria
- **SC-001** (profile: default, live-safe: yes): On `/invoices/INV-2026-000482`, the heading reads "Northwind Traders International Ltd", in full, at every width.

## Implementation decisions
- The name comes from the invoice's customer record, unshortened.

## Testing decisions
- One end-to-end test through the invoice page.

## Out of scope
- The invoice list.

## Clarifications
### Session 2026-11-04
- Q: Long names? → A: Shown in full, never cut.

## Left to the builder
- nothing
EOF

cat > "$RUN/tickets/01-invoice-customer.md" <<'EOF'
# 01: The customer's name on the invoice page

Status: done
Blocked by: none

## Goal
The invoice page names its customer at the top.

## Covers
- [x] FR-001, SC-001: the heading holds the customer's full name.

## Interfaces
- Consumes: `invoice.customer.name`.
- Produces: none

## Notes
- none
EOF

cat > "$RUN/tickets/01/plan.md" <<'EOF'
---
status: ready
ticket: 01-invoice-customer
context:
  - src/InvoiceHeader.jsx
  - src/invoice.css
---

# Plan 01: The customer's name on the invoice page

<frozen-after-approval>
Accounts staff open an invoice while a customer is on the phone, and today they check the customer by the invoice number alone. The page names the customer at the top, so they know at a glance that they have the right invoice.
</frozen-after-approval>

## Code map
- `src/InvoiceHeader.jsx` (change): the customer's name as an `h1`.
- `src/invoice.css` (change): the heading's style.

## Tasks
1. **Given** invoice INV-2026-000482 **When** its page opens **Then** the heading reads "Northwind Traders International Ltd". Test first: the end-to-end test.

## Verification
- `node --test` → 0 failures.

## UI states
- `/invoices/INV-2026-000482` invoice: open the page.

## Open questions
- none
EOF

cat > "$RUN/ui-states.json" <<'EOF'
{ "states": [{ "name": "01-invoice", "url": "http://localhost:{port:web}/invoices/INV-2026-000482" }] }
EOF

cat > "$RUN/captures/states.json" <<'EOF'
{
  "captured_at": "2026-11-04T10:00:00.000Z",
  "captures": [
    { "state": "01-invoice", "width": 390, "scheme": "light", "file": "captures/01-invoice-390-light.png", "overflow": true },
    { "state": "01-invoice", "width": 390, "scheme": "dark", "file": "captures/01-invoice-390-dark.png", "overflow": true },
    { "state": "01-invoice", "width": 768, "scheme": "light", "file": "captures/01-invoice-768-light.png", "overflow": false },
    { "state": "01-invoice", "width": 768, "scheme": "dark", "file": "captures/01-invoice-768-dark.png", "overflow": false },
    { "state": "01-invoice", "width": 1440, "scheme": "light", "file": "captures/01-invoice-1440-light.png", "overflow": false },
    { "state": "01-invoice", "width": 1440, "scheme": "dark", "file": "captures/01-invoice-1440-dark.png", "overflow": false }
  ]
}
EOF

cat > "$RUN/captures/axe.json" <<'EOF'
{
  "axe": [
    { "file": "captures/01-invoice-390-light.png", "violations": [] },
    { "file": "captures/01-invoice-390-dark.png", "violations": [] },
    { "file": "captures/01-invoice-768-light.png", "violations": [] },
    { "file": "captures/01-invoice-768-dark.png", "violations": [] },
    { "file": "captures/01-invoice-1440-light.png", "violations": [] },
    { "file": "captures/01-invoice-1440-dark.png", "violations": [] }
  ]
}
EOF

cat > "$RUN/touches.json" <<EOF
{ "base": "$(git rev-parse main)", "head": "$(git rev-parse HEAD)", "files_changed": 2,
  "touches": {
    "auth": { "hit": false, "paths": [], "patterns": [] }, "data": { "hit": false, "paths": [], "patterns": [] },
    "migrations": { "hit": false, "paths": [], "patterns": [] }, "network": { "hit": false, "paths": [], "patterns": [] },
    "files": { "hit": false, "paths": [], "patterns": [] }, "crypto": { "hit": false, "paths": [], "patterns": [] },
    "config": { "hit": false, "paths": [], "patterns": [] }, "deps": { "hit": false, "paths": [], "patterns": [] },
    "native": { "hit": false, "paths": [], "patterns": [] }, "api_contract": { "hit": false, "paths": [], "patterns": [] },
    "ui": { "hit": true, "paths": ["src/InvoiceHeader.jsx", "src/invoice.css"], "patterns": [] }, "tests": { "hit": false, "paths": [], "patterns": [] } },
  "new_env": [] }
EOF

{
  echo "# Commits $(git rev-parse --short=7 main)..$(git rev-parse --short=7 HEAD)"
  git log --oneline --no-decorate --no-color main..HEAD
  echo
  echo "# Files changed"
  git diff --stat=200 --no-color main HEAD
  echo
  echo "# Diff"
  git diff -U10 --no-color main HEAD
  echo
} > "$RUN/review.diff"

# The captures, as capture-states.mjs wrote them: 1x, each width's viewport, light and dark. At 390 px the heading
# runs past the right edge.
base64 --decode > "$RUN/captures/01-invoice-390-light.png" <<'EOF'
iVBORw0KGgoAAAANSUhEUgAAAYYAAANMCAMAAABvsvosAAAC0FBMVEX8/Pz4+Pjw9PT09PTg4OTM
0NTk5OhUWGQQGCSQlJg8RFAoMDxgZGzc3OCIjJQkKDioqLCgpKyYoKhIVGBUXGzAxMjU1Njk6OjE
xMiUmJyAhIzo6Og4PEg4QEwcIDCkqKyMkJhweIRcZHSosLS8vMSAhJBMVGSMlJyUlJyYnKCcnKTU
2NhMUFy0tLigpKjc3Ny4uLy8wMRsdID09PjEyMxgaHRITFgwNEBwdHyAgIikpKxcYGhQVGCEiJBA
SFCQlJzo7Ow0OERscHisrLRYXGhkbHS8vMBESFTs7OyssLRkbHiEiJTw8PRocHywtLyEjJTIzNBY
YHCQmKDo6OxQXGh4gIhYYGyUnKSIjJi0uMCUmKSMkJxcZHDs7PCIkJjw8PC0uLxsdHzY3Nx0fIi4
vMDIyMxobHSIjJDAwMS0tLywsLh4fIScoKjY2Nzg4OCYnKTQ0NSUmKB0fIRQWGRwdIDk5ORweIDM
0NB0eICcoKTIzMx8gIiwtLhQWGCMjJTU2NyAiJSorLRobHhcYGxkaHCgqKzg5OTc4OCorLDIyNB0
eISkrLDY3ODMzNBgZHDQ1NiMkJSkqLCwsLR8gIz4+Pw4PEwsNEDs8PB4gIx8hIzAwMissLiAiJC8
wMicpKjQ1NRkaHRscHygoKjM2PR0lORQeOAsWNgcTNh4lOiEoOgcUNjU3PQ8aNxEbNzI1PRMdOBU
eOAoWNgwXNiEnOicsOzY4PikuOzo7Pzg6PhsjOTw9Py8zPSIoOj09PyAnOiAmOjc5PgkVNiouPDU
3Pg0YNyUrOzo8PykuPAgUNiUqOzw8PwsXNj4/PywxPC4xPDAzPRcgOBoiOTk6PiMpOhIcNxAaNzo
7Pi4yPBwkOTQ3PiovPB8mOjA0PSQqOzE0PTs8Pzk7Pg4ZNywwPDQ2PSswPAkUNh4mOjU4Ph0kORQ
dOCIpOg8ZNyYsOxghORYfOBIbNz0GX+AAAAjqUlEQVR42u3d/2MT550n8M9YQjyAbdn5WMIYW8au
EQkQgi0Z2wHbGAwIYfwFOwaCZQE2aVJjbKLE4WuISWK7CY5D471AaTbNZbdKuv2+20s3We6SbbbX
XrvXbXfb7fZ627297d3t3d7ev3B9npmRRrIk5HzBqXm/fgBJM/NIet6a53lmJM9DBAAAAAAAAAAA
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
EOF

base64 --decode > "$RUN/captures/01-invoice-390-dark.png" <<'EOF'
iVBORw0KGgoAAAANSUhEUgAAAYYAAANMCAMAAABvsvosAAABm1BMVEUIECAQGCggIDAYIDAQGCAg
KDg4QEjg4ODw8PCwsLjo6Ojo8PDY2NhASFCwuLiQmKCYmKBocHiYoKiQmKhASFgwOEggKDCoqLC4
wMAwOEDo6PAYICiQmJiAiJhYYGhIUFh4gJAQECBweICgqKigoKhQUGDg4OiAiJBISFh4gIiIkJjI
yNDAwMjY2OC4uMAoMEBoaHDI0NBQWGDQ0Njg6OiIkJCIkKBQWGg4QFBocICYmKhweIhgaHB4eIDY
4OCQkJgYGCjQ0NBwcICIiJCAgIhAQFDAyMgoKDhgYHCQkKDIyMiosLCIiJhYYHBYWGjQ2NgwMEBI
UGAoMDhgaHhwcHhgYGhoaHiAgJAYKEA4OEh4eIhYWGCgqLCYoKAYMFA4aKBIgMBYmOhgoPg4YJBY
oPAYKEhQiNhQiNBYoPhIgMhYkOAQGDBIeLgIGChAcKgoSHhQkNhAaKggOGAwUIAoQGgQKEBAeLgY
MEhIeMBQkOAgMFAoSHAoUHhAcLAgOFhYmPAQIDg4YJgwWJBIiNBYmOAgQGAwWIggQGg4WJANMPkU
AAAgwklEQVR42u3d+1/bRro/8Mf4wmAwsh9jA3ZtE0NwLWwcTGpuTiAXQkKBgEk2Tbunadyc03a7
OdvTW3a32za7e7bn+2d/XzMjyZJvmDQNWfi8f0jAksb2fKSZkWw0RAAAAAAAAAAAAAAAAADd+Yb8
rt+GhgKn2joYCqIK3YaFGBl45bCQRsciRONCEAlh0IgYpYAQ0VM8Z4yZOT7RbVEi+RreU0xM9lk6
JfxvXQrTQojUKWMQQqTtGN6hESFOGUOGjWxuhjnUuegS53/zGGbD6bcuhjlZqZcHj2G+UIjOCxGj
d4v5VgxULIYGfsoJNmULFmHjbGJ4G82LlBDjqjlYSIVLMaJoedwYDi8GRsIp+WYqCykxdsWJYYmI
qnLfN8vLrhjK5TxNld8ZCV+drBDRe8Ni7Eq53P3gr3FF/V+sBXzmChHli0SrRTbWLg2ZvF4gytU4
vhYg2shfrsXXfPm4UScifzFubKSJqmYlU7A26B1DtFwti/lrVBwuyucarlPuuhDL00Sb5S0KLKbE
jZtEdGtYlG/LTRZEasp3VilsCzE5r1qlhG5tbtEd/UNK/sO0o38r2jGUc7m7C0Jsd2mU5vWq14kM
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
UdW/Ioav6a/NZx/IkatscZzmxonhj/LbZl88l73yD3L5N+Q0XIjh9cXwhOj/viN60Wx+/tJ1HuHE
8PNPetD0VVP2Hh83vyd7MIUYXmMMT78levmLOgx+IfqxI4bmz396TvTxZ3JV2W+rfxDD67+09/Nf
rB9+UN1Al2+CffUUZ9Fv6grrN38l5xDBxYwzi+EDou/+FzGcdQz//PGTZ7i0d+Yx4AorYkAMiAEx
IAbEgBgQA2I4E3/An5m8Df74hmL4I6q6n0/fUAz4i9y+Xj57Iyk8fYmq7uubNxLDN6joE/zzTdys
AdV8cveAW5e8FXAjHwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAgAvp/wNgqtJBh7sKoAAAAABJRU5ErkJggg==
EOF

base64 --decode > "$RUN/captures/01-invoice-768-light.png" <<'EOF'
iVBORw0KGgoAAAANSUhEUgAAAwAAAAQACAMAAABh+M4yAAAC0FBMVEX8/Pz4+Pjw9PT09PTg4OTM
0NTk5OhUWGQQGCSQlJg8RFAoMDxgZGzc3OCIjJQkKDioqLCgpKyYoKhIVGBUXGzAxMjU1Njk6OjE
xMiUmJyAhIzo6Og4PEg4QEwcIDCkqKyMkJhweIRcZHSosLS8vMSAhJBMVGSMlJyUlJyYnKCcnKTU
2NhMUFy0tLigpKjc3Ny4uLy8wMRsdID09PjEyMxgaHRITFgwNEBwdHyAgIikpKxcYGhQVGCEiJBA
SFCQlJzo7Ow0OERscHisrLRYXGhkbHS8vMBESFTs7OyssLRkbHiEiJTw8PRocHywtLyEjJTIzNBY
YHCQmKDo6OxQXGh4gIhYYGyUnKSIjJi0uMCUmKSMkJxcZHDs7PCIkJjw8PC0uLxsdHzY3Nx0fIi4
vMDIyMxobHSIjJDAwMS0tLywsLh4fIScoKjY2Nzg4OCYnKTQ0NSUmKB0fIRQWGRwdIDk5ORweIDM
0NB0eICcoKTIzMx8gIiwtLhQWGCMjJTU2NyAiJSorLRobHhcYGxkaHCgqKzg5OTc4OCorLDIyNB0
eISkrLDY3ODMzNBgZHDQ1NiMkJSkqLCwsLR8gIz4+Pw4PEwsNEDs8PB4gIx8hIzAwMissLiAiJC8
wMicpKjQ1NRkaHRscHygoKjM2PR0lORQeOAsWNgcTNh4lOiEoOgcUNjU3PQ8aNxEbNzI1PRMdOBU
eOAoWNgwXNiEnOicsOzY4PikuOzo7Pzg6PhsjOTw9Py8zPSIoOj09PyAnOiAmOjc5PgkVNiouPDU
3Pg0YNyUrOzo8PykuPAgUNiUqOzw8PwsXNj4/PywxPC4xPDAzPRcgOBoiOTk6PiMpOhIcNxAaNzo
7Pi4yPBwkOTQ3PiovPB8mOjA0PSQqOzE0PTs8Pzk7Pg4ZNywwPDQ2PSswPAkUNh4mOjU4Ph0kORQ
dOCIpOg8ZNyYsOxghORYfOBIbNz0GX+AAAAprklEQVR42u3d+2NU533n8e9ohuHhIgb5QULcBqSI
wVyMkUZCyBjEHTEISSBZgJE0gGQbRwgJTyxzNRa2BbVRMLF2DSGp43WTidOmt91sUqfeddq0m27b
bZu26WWzTbfb7m53u7v/wvY5l5kzo5GQMChy9H79ADPn8szMOc/nnOd5zpmRCAAAAAAAAAAAAAAA
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
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABMR/8f0g+fd3zrZYEAAAAASUVORK5C
YII=
EOF

base64 --decode > "$RUN/captures/01-invoice-768-dark.png" <<'EOF'
iVBORw0KGgoAAAANSUhEUgAAAwAAAAQACAMAAABh+M4yAAABm1BMVEUIECAQGCggIDAYIDAQGCAg
KDg4QEjg4ODw8PCwsLjo6Ojo8PDY2NhASFCwuLiQmKCYmKBocHiYoKiQmKhASFgwOEggKDCoqLC4
wMAwOEDo6PAYICiQmJiAiJhYYGhIUFh4gJAQECBweICgqKigoKhQUGDg4OiAiJBISFh4gIiIkJjI
yNDAwMjY2OC4uMAoMEBoaHDI0NBQWGDQ0Njg6OiIkJCIkKBQWGg4QFBocICYmKhweIhgaHB4eIDY
4OCQkJgYGCjQ0NBwcICIiJCAgIhAQFDAyMgoKDhgYHCQkKDIyMiosLCIiJhYYHBYWGjQ2NgwMEBI
UGAoMDhgaHhwcHhgYGhoaHiAgJAYKEA4OEh4eIhYWGCgqLCYoKAYMFA4aKBIgMBYmOhgoPg4YJBY
oPAYKEhQiNhQiNBYoPhIgMhYkOAQGDBIeLgIGChAcKgoSHhQkNhAaKggOGAwUIAoQGgQKEBAeLgY
MEhIeMBQkOAgMFAoSHAoUHhAcLAgOFhYmPAQIDg4YJgwWJBIiNBYmOAgQGAwWIggQGg4WJANMPkU
AAAmd0lEQVR42u3di3sa17nv8RcB0hIWHvEiJAsCKMgWAV2wkYtu2JIvshzFsiVs13GSk4vivXtJ
c9qdpE0vu03a7mafP/s8ay4wICRLrq0q1ffzPIlhLguYWb+ZtdYMSAQAAAAAAAAAAAAAAAAAAAAA
AAA47yID0dCzgYHYidaOD8bZhDgLhowZPvbCCWNdGEmKXDRGxBhHhs0FiRkzeoLXTKmqpsf6zcqM
v4bPlDITR8y9ZKLsdvgmjTHZEwbAGJMLAvCWDBtzwgDk1SkUp1QHD856W0tvPADTiRz7Hb7Ltjpf
OX4AZsrl0RljUvJOpdQJgFQqg8d+yTGt2vZSUp1/TQCAjhmTNeai2/iYzSbmUiKj8xedocRCbDiR
tdWoNps1I1fbAbgmInV7vK/OL4YCMD9fkkvzbw0nrk/UROQnQ2bk6vx8/6ZGQ2vuv5VGLFJdEpFS
RWS5os7K2wNVXS2LFBuaXomJrJWuNNIrkVLaaYpItJJ21nIi9WotX/ZXODwAo/P1eTNzQypDFfta
Q00p3jRmcVJkfX5DYgtZc+u2iNwZMvN37SqzJnspQn04bzaNmZhx20AZr21zR+55D7L2fypb3rNK
EID5YvH+rDGbfZpAM96iN0Ucv6G01fc1Q0f+qKZsIhzJqLPyrpaitlZLXZ1UXvMijmrVdhfKaU1K
blWrU5rOuT2Ikr/C4QG4ZMzQrDGTg2ZeRObNeNGYS7PGjLt9gEV3ZkEmjNlOGJWmSSxcN3NUiPPm
PWOSE7YmyLYxo+ULZsYGYG7UGDM7asyQzBlTbSaCbkLQB5iT/gEYLSWMiURskIYPC0BUHxwMQEon
RSqO2wSKadoe/XVZHF2WDdVJmdSUlLQoUtQdSemDgfYKRwRgTmTUlGTIDMiWuSXzJilSNhdtAB6a
R/ZEdmnSXN+QjYSJLZiHIrMJKsR5kzAJSboVOmvrROnisA2AyCNzQWTEJOwCN25sG1Ps7gQX+gZg
yFY5s1s0Zl1k9pAAbGj5YAB21NmL+n2ASffAPqhNcVbtCSNt/1eRtG7F4y3NS0qXpb3CEQEYtHVc
5S1TlnVzW4yt3hEzbwMwbW6IyO1C2Vzc3NycM/XLJvGTXarDuVM0JrGwYLwqfNGbds8e7rdtdVk0
CQlq/NVQH6BkzGzfAMyK3DFmt+SeUtZf1gRafhxtB0DWVLWx6QagaA/1Mq4lcRp28bwXAPU0JKUb
0l7hiADk7Oe7LONmUeZNrGa27axswgZgzmwGJ0Dv00Vsw2/mCTXinLnYqd/G3BNJPrnaE4CsHfcp
l8u7oQDkjLneNwDbXgAKxtwV23jaOqQT7F0ES2vMC4CbiMhYRTVnA5DUHXeQqNkTgHTNivsB8Fc4
IgARLwDyyEyaSxJ1+wJR7wywYBMqxc3LZvqKFRUZqMwa06JKnC9ZY2ZnZ28Zsy3XTXYgYlsx4QBc
l3lbK6ojj6JBJ/jKlae2l3BUAMaNSbxTOrQTvOe1gew/Ea2IbKkjlaqI/FQzNgBxt8qnNNkdgIba
app+7AUgWOEYAaiYeduCu2DcOQs2AOt2nLRo5p7Y1MvFbHz2pogMm6dUiXOl4F8FzhoT+0lnFCgc
gPvegNCt7k6wqR8VAFk4chRIHmhjp1hSHbfjPLf3HHVkT9cyg45uiDrLktdmbc+eFroCMKZOccnR
SS8A7RVeHoCIcZv/0+ZaPZU1GRuAnDHlu9fNU0mYudS2GZGquVe4mjXj1Ilz5ZLfuV0w5omtyMZM
26ZLOABStpMXx7sCMF8Qb/jfuxWiJwA1keEL5uY9c1h92rDtd63aucuq+qzqSKxhJxVFbqtK1I59
OvGeAEhTVVeL9twQkc4KRwbgHaNur+aybTLN2bf+xLsVop41JrEusnndfrqW5IbszDJV4jyLPnzY
74AaK94/4Y1rsWZz003VoUtEJjPBRaeW/6C17E3asO8hvtzvJSOZTOiWu2CF46tdLXbW3/QvXSev
eg/eefKU4z9ei5gxZnjBXkUAzqO7bkMpMciWwDlVH10vcGcNAADA6Zk1r2qRjQcAAAAAAAAAAAAA
AAAAAM6i94FzjCMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAcNbEW4fOifebGt0Vie+6
D3c3orsR+yCym2ND4scp7xw2p1ztN3VHc9LQHRHJ6d6yFuy0pg668+476tg5KSdd2RCJ51XzcZF4
RbUS8df35w2spZ3HIpIpa7Xoznj73bKI1B9oJSMSWUtrY5m9g39hAOJbhwdAB9wAiDbsNCftz3o2
VtJlKele0nFENF3YSzck5jh7S/rYW92f93bDSda1JHF9tpzSMW9OXqSoO8m8RqWsK2NV3WD34BQC
EG+MVbU6Pt7YE5Hqjgw21FkSebwispPWSk0k2dD8ZCgA1dW8F4AVm4S4pryi7CF8tRzTpsiYPs9o
TWRJa0saFUnW3UWCeZuasVU+llKbH3uqGdNG3otjTYtiTzFb3ukFeMMBqKmW1rQs6arIoC7XNL/3
gdZtE6igazvptCS1UWhoqxOA/JiOuQGo2ZraVO9ccSVjU/GsZit3S5e2bP1d0dZKI7m25rWRJJhX
sBX/obbcZlZZRcZ1LJ+3pS9NljUaKcRFkrrE7sGpBOCxyFpaHuuGlFSmbOWsOjYAtlWS1K2GY4/d
K6EASF4jNgDiNLz/gi5yVTNjGreLu22eulalrOqoemeAYF7JvsayPnembLdARRoVsQGIpFV1zV00
s6p0rXE6ARgUua8St436FXHyIvJYpVzNuZ1dEXVKJbeJ3glAXEtuAHZ0PK4FmUrb04c8VF2WPfdc
YQ/f8Qe289vQMYk6q+4ywbw1LwCt9DMvAKnViBuAKU0V8/btREraiLN3cDoBmLQ1WeTdsm23r9oj
8E9tAGwi7CinOpVKpbITDoA0dczOjepOU3OyU6mkJJbXtZyt10k7/bkkNZ20r6BuoGJ2mWBeSiO2
xysNe/JYq4quVquq1bhO2Zdbk3jazx5wegHY0TVHxDZ45EFaytWYbY0MOnG1vdudsa4AiLPqxuPB
u07eLypla7et301buXM5rUa84Z0NkYpKeF7R7QQ7sqYxEackP02lUk46Fdfbbj9aGsrhH6cegKja
425B92Jj2rR9gGe6tNtYlZIuxf3Byk4AnqsbgD3Vol+U4xSLxeKgPNDBWrohRW3a57maPqst+Q37
YF5MG60xTUlG1+JN9Qb8y3kRR/fij3Upp1N21Ra7B6cZAKnaEUuZUtWpmA1AtKHayEgkrxoM5LsB
sGcEqbgBiKg9iHstJVdVco5qOior3vOMLKnqA39M358nGVW3U1HolGwD0LKvVJGkt2qT3YN/hWim
Pf4yEHX/Gc+caESm5y6KyOTAwXm7XsmRTKR72UyUHQAAAAAAAAAAAAAAAAAAAAAAwEtsTExMTAS/
AVeamJhIHXfNyujo6ObLF5u+d+/ekyOXqF++fLncfvbhRI+tY7yX7iJOIGdfofjGt/KNe/fujb7S
muWJiYl66PlHExMTL/m9pNrly5cvU7OPaddY/ia+ZYy595IVnjebTbfeJ4wx6y9/gRljzMSRS0wY
Y2Y6gTE9rhzjU3QXcQKT9hX6/jhesdlsbv2TG3e82Wy6m3bBGHPzlYoYMsZMd55G7PsdPvp9PrXL
8LWiEwVg6PgBsPty9hwE4PrxPt6RSsaYC284AAffJwE4eQDMXQJAAM5zALIbbyoA9yuVyuYJam9x
1Lrl7mj34fi/QQCSlUqlQADOcAC8g3QoAJt3hxe3R5vedowVCoW6SGV4IlqbM8Ys1lpBAOqjc9Mp
+435SKFQsD/pKYOFQuEdu5adMC7vFAqFmu2n1utXRCrvXdKrwWvHrqxfWt/sW3vfsu/J/Zkht7wt
2dRLbms6eWN6bqI6eHgRH67PLdz1528VCoVBGV9fcE9whdFLswujyb4BiNbrdbvkxQXH7RKP1+zH
09r4UWXu1uv1mgyOLgzf2W1vz9TopeHRh25lrd2xAajVYjJZKBT8F27d/ujatYlSzV+8TxFdH/El
Aeh+n4Plhek6AXilAJjdcABiC/7UrHvcGrQPMwljsrPB4lE3AG9te0sl/YLs4MO8nWAP5XZCM2gC
jdtnm1l38Rk3H5KZcZ/Nvnd0AOxLjn5kjCmLtEb8lx9K9i8iOeO/b/cnVdaNMbdS3ocabK862CcA
FTuj5C1wa0Ak6y98/agy7bFgeNib+Z6Xx+Fgu90QqQbbqhRqAt0JJnpH7YNF9HzElwQg/D43vJ2T
uEEAThqAhN+sCQKwNdNpgo8GAbAL9QagbdA7IyyKiPt8y6spJtYVgGB3JWyD60p4/ZcE4KZxA/A8
tEayXxGlztMnfmV1P8o9Gc+252Rb/QNwIVhgu6tiHV7mXOgjmTtBdfVV+gZgu7PAtSAAXUX0fsTj
B2DgenhrEICTBKDkD4UGAZgLb8pNPwBu3dk+JABzXucgK5IJqsq2F4hwAEz48Dd0ggAYLwCzoTWG
+xSRu9BdBdaDx/e8mpedv9BTgcIBCH/kbLvQI8rs2ky2rf+T0POhzsH+djsAd8Nr/KR3S18If9rQ
RzxGAGZEhg0BeNUAJC95Q6F+AJLeCT9ScxtCi50ADG179fxa0Ak2N5M5d6dmRa56Dakbwb6z86s9
AZgrTl60/14SaXpJSM0dMwCJ+fvuyeVWVAbtbp/vU4RbB0Y3rrgTqu3KemF+1K0pl0UiI90v1h2A
0cmkbcCZG6HO5RFlupMulLaeutVwXGTRvs/n0rrmnfwOjALF3AWr0ah7criwIQeL6PmIx+8Eexv4
vavDWQJw8gCMe0OhfgDm/EaNf8ae9ANQPjgKZDb8hpPx980N/0A0LwP2n1p3AEaC9eZFrgVVvHKc
AAyNB/t4UNonmwNFBLXGfY2hoLLaXu2G+/LPRT68du3a9iEBsD2YlvFrXFCxDi/T20714MD+oVdb
7wQtsdrBAFTabaU7/gbtLaL3Ix4/AO77eitorxKAkwXArXDZDT8AN/3WvN+RTXnbdLjPMOicfXDZ
C4Db+71o/2/Xd08I16U7ANVgqGnIm55oD3S8LACd/blZurzon3N6i4jZ6RdTqVRq21tn3euHS9Az
MYl7d+J9R4Eq7cwH3VG/Yh1V5pxfSb1T5n2vxNpVx2sn9gnAhL+lgmIPKSL0EY8fAPfM6vZuhgnA
yQPgVucJPwAXOteuvG6wG4BCnwBcbh/NRGTUrdl+l2Jwwt9T4QA8DKrNkFeymx+59PIAzPuTHy52
urIHi9jsvoKW8Sqrt2an9zlfPCwAEnysUACOKnMueGdbQe2dvNTpMfQJwLXO9TBbsR/1K6L7Ix4/
ALfaRwNGgV4lAG57esgLQDD44wfgoheAzcMuhAUBcOuKXdSudXfEr/Bdw6CdAETarQH5Py8PwDVv
aipUFbMHi6h3V9aiW1kv+APm850Zdw8ZBeoXgKPKnAveWVB7n2dDi/YJwEj71Op2F2b6FNH9EU8Q
gHlv+Co4bROAEwZAHrUHN9xm73DnTO341wFeFgBvPVu7HxlzKZh4SABCKRt+eQC2Q9csrl+8Mdo5
A4SLcBO4OBvwjtbZoMirnZPA1vEDcFSZB2qv2y3Kzv3k6SEB2O7cdmUr9q2DRfR+xJMFwAtXkwC8
SgAGOwGYbzc6Cl6D95gB8Mf0Ltq2bjbYs4cFINE+sM8fNwB3gx7je17t6C0iFmqpSXDRyquskVar
NS716Zv+wPyxA3BEmQdqbyvoh94/JADufU7uD81H/YrcW0TvRzx+ANq9Ca+nQQBOGgCvF+UG4GJ7
p897x8veANzqHwD/ktENf3zSGzY6LACLQbezYI4bgIXgAHrT29kHisgG4VwfGRm5Fq6sGgxZPTRd
984cHYC35KgyD9Tekj/66VVBPwAmFIAn9vlHdsJH/mhrbxG9H/F4AXjL74G5DcI4o0CvFoBoOwDe
eXi02Bzxu5m9AcgOjvcLQDRo/PoP4kcFwEtLtaDm2AG46F1p8C4lZPsU4V63mCsUh72R2FBldS9S
XMpJrNzujB8jALcmo0eUeaD2prwrwNE7wb0l7ht82OrcDeperF34sO4WmuhTRO9H7BuAjsud91nz
bum6X+Y6wCsGwL90f096Liq2ugOg4SvB3QHwrsxmg2sEXmv3sACc6EqwF4CyCW7J8KtrbxEb4U5o
PVxZo97ojD9GEzlGAEb8Qg8v85AGfKJzd0i990pwM/yGn/Qpou9HPDwAE5336TaauBL8zwTAOz7Z
AGxc62zJknQHYPCIAEz7V469QceJowOQDGrWzeMGYCOoWwm/gh0o4mHnfd/pbq/fD1WO5nFGgarB
PTaHl3mgExx0s7MmdBWt616g6a7Ke7CIAx/xpQFov8/cUGhjEIDjarWvAPk3ks+1u3ruUdyt9s+D
20Xb171M1I1Ltd037QzAXQ5WvxIOwED7dS61h769Hul0qU8A1jsDr7Ohe7S9fTzspulWvyK27vmn
g83gnBaMAtWDcdChp6HXqflVtdReMuHXzeh2cJfloWW2xwPG/U5T1Ltt49b4jL9JnmS9AFzsDCv4
mc3e719E70ccCq62HBaAzvuMuSNvZnEr6O/gn5GsTIw2+/+13t16PflaXmOy8lYhcqI1HlbXi0cX
sdUcvZyq9Vt384nz0Wjp+O88Nvhh8flLyjzwGndHm11vJ16sv9N9NJ58Mj19O3OCj3j89zmeGn0y
TtUFAAAAAAAAAAAAAAAAAAAAgPOgtru7Gz/JCrvur49Fdo9VeJwNjLNNXbff7jvz7ZKz+oH9GlfK
SVc2ghUm7Xe/dOAYhTdKh8y476iz0yk3nlfNx0XiFdVKhJ2CUwzAWiwWL+izvjPXdGUsry0p6V7S
cYIAOP90AHb02VhJl9vlarqwl25IzHH2lvQxOwWnGAC3jv5Ua1uNlsjDZyKRtbTj/7HgdEoko8WY
NkXG1PvanU7pjheAWGlVy+OSXxGRlalgvWJ1711naezd1ZJIY+qZOnvuET9dyUm0MfbALix5+4tB
q+Wg3IzWRJa0tqRRkWSdnYLTDkBNr+zaps2KI9LQlZ9qxZ25FZFIWXM1zYi0dMlbYaek424Ayrqz
lE6//YHGJKapYL2C6oqjulbRojTUeZzW55LSqZ3VtMRV0+7XXa9kRHL6LCh3y/4I14q2VhrJtbVB
9glOPQA5bQYBSGpRpKl+i39FtSRjGheJ+W0T3Ylo3gZgy54JMloc1KSMaStYr6AZyegHIjYTabve
VM6+SEaT8VBLK1rVTLjculalrOqocgbAqQdgXItBAB7rWqlUVv83EFqFqhb31I78tM8AUtRiUQeK
akeC9LGsfiBT77bXK6hIXMdE0iVprNnfEWlkNF8qlXTHnex5qLosnXLjD2znt6FjEnVW2Sk47QAs
adwNQMWRFa1YdgAzshwRieizZU2KRIM+wI7IA63rQN222O3xe0UjWmiv5wVguROAfCOpeTsrGfeL
kFhe13Ii7XKTmra/VpJXEXmsMfYKTjcAG86q1HRQpOHIQ3vwr6XsYOSG2xzRctR2Vouaawcgrqs6
sGyP5xndk5re1mh7va4ANNxec0sLIpFUrR2AlHq/RuqXm9OqO/ZZsg2virJTcIoBeFAsFtKakZhW
J5vqyIA+qAVjng+c3daa1uWBDtbSDWkHQB6rDsRWGwPRvEZEHM1Le72uAOjOQFMHxUkna3mNtgPg
OMVisTgYlFvUpn2eq+mz2pKusVNwigGwykn3sKxO2bGHZNV3vT+lm7EzSyI5RzUdDQXgbUcHZNDO
XbY/+Wr7v8F6XQGoqto+bstRXR2TuHo/iBbxrr5Vg3JXvOcZWVLVB/yoH/41Iv6NC7HJ9q8Avl2b
9OpjvN9NDW/Xun4uMLReR827sNua7N+y7yk3MjnAfgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAMC/kVhqbmRm6NrCEzYFzqG7F0xgumdWbsaKH7JifPTRzIXszbnR4oFZo9uu
zl/Pi5SuJYwxiVuVw/4a5ODEUNaY7NDEZtdrrM8njLkwM/eUHYU34poJudn9Bx9vuxMz/Vcc7qw2
N949q+5PrwcTHmbby2bv9yssshAqrZORamfq0CT7Cq/foulyPRKeef3wAMTmu9a73TVzpicAT7qW
vdGntKHwAjORgxkzxgyyt/C6jZoe2515Uf+o3DcAF3vWCy/kmO4AZHqW3TxQ2kL3AnPe1FL31ESE
/YXXa9Ic8KE/a3y0X90OvNO72s3OvC3TE4DtnmWv9Zb2vLe0pDs52zN1nR2G12vWr72pDdm85D2+
ZafPZQ85uPecAIYmysGp4E573nZPAGp+4/9yQbP9S/RferZ021/3np16w3+N6n2/KZRlh+G1ivpV
zOt1rnvPdkVk3rwkAF5NXrQPi6E6axVMTwD8U0mxc+K43FNaKHp+n7zTPcnmOm+tzi7D61T2qljU
fzriPq0cIwC73pyNUFd1JpiXcNvroQr7yH28EGrsz3eX5kdoK9R+etiOxe1Qt/ojdhle07F/3fKq
1Yj7eL0kKffp8DEC4B3lR7oO+eFu9cR8KADe7Cfh8aDu0jScoHZV92OROzw4wKtKHez9JiQyc/36
9ev2aljpI+u9QwNw151xyXvij/oPdBr82Y1QAFre7Fb41NFd5Fx46Oee1x0IXiPRda5ix+H1mDgY
gHuHdRH6BKA+a5Uk3HfwnlzzWlGhAHSfILwnV7tK8xZ+K3QGMUPBW7zV1UqKsefwWjw6GID1EwSg
y0yoBdP0a28oAOXwkdzvPVf79KgrPcf6e+Hzwi7XwvA6JQ4GoPiKAZgOXbyKJfySQgFY7+ojey88
2lXChVAnIbj6FYwHXfSmDhz2HoFX5g20lw/vKR8nANXwjQrTQRRCAdCuC2VDfYZzvAL8e4SuBgHw
TlITXcs8ZKfh9bkbbnq8YgCGw3cvTLaHM0MBqIZHjPwZw32aQPWeMaX5rksG3tQmOw2v+wxw958I
QO1mMITk3jO92G7ehAIw3TWCebNPALqucj3tDsA0AcAb0Jqbm5vzLnzNz7mevEIArrbvcbaXj72x
1USsJwDtYZ1Qj3m6TwD8yp0KArAYjkqES8F4nUoH+sDTJw9Aeyx1qNXp4KakJwBeJ/j6SzvB/qBq
JQjAbOgCsox7U99hz+G1GD4QAHsAbqZSqVTmmAGIjgSrLnQdybvd9Wt0tqu9f6fPkJTfGb8TLD4X
vjrh31HNl2LweswfqKnRYLD9veMFYHzmwJdh+gXACS4Udy1T6CpqJDwyNBF0GS6H+w5P+91CAbyq
xYQV9GATicRIu7X+9FgBaH+Ha74lRwcgGr7FPxm+LyKwEL7muxgMKpXCdX6062oa8Fp41Sq70dU8
iR0rAHPm4J3N/QPgF+u1cMr9juTVcCMpG3QSBjt3ZweXhRfZZXitY0F+H9a7H9rrdT46vBN8/4nl
XvHy780xTw+25Xv7AP4XZOZDrR33K2FNt7RWp4HvXuWqd741me10zqMX+EoY3gD/lqCZ0vjG/ZHe
b3YdCECoy+t/c2v2TkfkYB/DG7W8245C8CWvaqc0p3PUdwdQr3fOBvc6l5j9r4w9Z4/htUoeOGIP
yXECEOlzrB88LAAb/gKPLj/qdLi7AnDZv5pwcdg/iUyETgZme9rvb/B1ALxuvT/u0PWLDYcHoHSS
AMh7PUtelJ4ARHvL8n5naKhnaor9hdcsNtJdx7q+rXt4ACZOFICN7s5BItobgKBvHKj2PT/Nsrvw
2kUe9al5Lw3A9okCIIPhH5m4kJQDAei+MBdcWOs+0QxtsLfwBpTbvw060/OLVRvhgch2lR0++Hty
3Yt1Rnvat+8PdBIzO95VWhC5J+2MZEudYjY7raAJ9hTekObC4tD8XPXKMb5wOP+qY5Hjdy7OXptd
qI4fukR9Yu7WtbmJnlv+n49eunVte7jEr8LhLDSYDnyfFzhHpo25QFMc59T48IE7mYHzw/aWh/hl
EpxXjMXgXLu2kGQjAAAAAAAAAAAAAACAMyje6p2S2+1+Phntt5q3UHQ3JlKr2T9d5OMWOfyo5J3e
KUva/Xx1p89qKbW1Xh5oRAZUBySqvnB6oinvD0bKfUcdt5RI2n5huLZSsH/zNF9j8+NHGoCW2p8m
yemUyGPVpkgkEqk6kUjXFxZr6n2NfkefjZV0WeJLDd20k5tTjkgyz9bHWQhAvDFWVfsd3eV3NT9m
A1C031Cv3BfZcZymDcB9J13JidQ+8I/kIu+m7bd3dVkkvfbA6cnSWF6rBYk76rh3jebtz4GulqXe
cGwAVqZENCNOi62PsxCAmmppTctS02qhoVtLKjv2JNBYkx1t3FbdkZRO7aymRRrVekW9O6ELtg30
YFUko5krXnuoHYAtrdY/0NrGit52K/mVjD1ZPHPPCZsiy7rcVFn6gI2PMxKAxyJraZnSiOS0HgqA
VkWSupPTkq3oyaht6zwe87rKmpKcrohU0hLR210BeJ6PiejjdhPIdgeq7mM3ALKizlgkHRU6zDgb
ARgUua/i5IM+gB8At8JHdCej+VKppDtS1sbjoOGST8uS1iSi1UIhrd1NoOj9KacrAA/VNpaCANia
/zg1XtYHtIJwFgIwaTuqopWuAKTXWrpn/7zvTlLzlUqlkpRI/YGq/6NZRZ2sOiJ7urq66k1sByCj
6bWlUABieV3LSSgAIrl0pFTNlKfYATgzAWg4IhFnb0mloPbIvxbRNZFJ3WlpQSSSqrVSb0vEP09I
TCu6I1J9V0TetqNBnQBUNCaxUABSmmyPC/kBKBUkXZRBZQfgzARgSVdaFbcTvKyl2jNdk7JmalXd
ESedrOU1mtOVaHw1+GnmD1SjMq7uqJDtPnQCUNJ4fEpXJK4Fd1jUcYrFYnEwFIC4I7LSSFYr7ACc
mQDImmq6LnWV2APVamNNBhzVanpHWo7q6pg9lKtW/YtbMqh5kaa614nHbGOpMwqUVn02pWPSUPur
uBHvElnVDYDbFZDymEh0TStxdgDOkI12hYzm/DaLP6U16Q7ZRJ/njlVQbUPEBuWwpTNsawAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA45z7+5NPP9t+Uzz795GM2Mc6wz1/sv1kvPmcj46z6
j//cf/N+9h9saJzR4//+aeAcgDPa/v/5qQTg55wCcCZ9sn86PmFT4yz6xSkF4FM2Nc6iz04pAL9k
U+Ms2j8tbGoQAIAAAAQAIAAAAQAIAEAAAAIA/MsD8IU76/1fEQCcywB86c/8vwQA5zMAv/7Nf/6X
yFcEAOczAF/v7+9/I/Lz/V/8+rdffvz5z3/37be/2d///bff/sFd4I/f/v5PX3zxtf0u5SdfyW//
+7P9P3/71f7+f3378Yv9P3/7FwKAH38Avntfvt//7nt3qb9+JvLX/f0/yftBbXZbSX/d3/+bO//7
z34m8pv9r0T+vv+NfEMA8CMPwG+/+eoLkV/v/+633//hf96Xb/b/IR/vv/gy+AKlyJc/+8MX8o/9
X4j84xefi3y9/7188sJm4sWX/bsObGr82DrB79svC3z3+799IV/t/1nkl5/ao7xfm3+w54OP9/8q
8sv9/b/I9/tfy//+QsT932cEAD/yAHz7ww+f/O7F/v6L/3aX+mr/uy/lk6/l43Zt/mR/3z71GkX/
T+TFp/Ll3+Qb+fIH+QudYPw7dIL9X3P4/Gd/kn/s7/+3/OX79jeI2wH4m8h3trv8hW0ffSm/e1++
PORrxmxq/AgD8JX8cf/F+3Y81LZv2o2bdgB+ZX9X6xdf2n7vn+z8r6XdTCIA+PEH4BOR//2tyLf7
+z//PnRdoB2A7/7iDQj9Zt/2Ej7e/50EA0UEAP8GAfjsG5Hvf3AP/T+I/PlAAPa/+/WXIh//zC5q
e8bu/wgAftwBCPvuD/6DP7nN/T6/efWbz7gSjH/bAPi+/qO0TwvcCoFzF4D3RX77PwQA5zUAf//z
py+4GQ7nNgDcDQoCQABAAAgACAABAAEgACAABAAEgADgR+qX/IEMnGe/OqUA/IpNjbPo81MKAH8n
FWfS9y9Opf5/9j2bGmfS16cSgK/Z0Dij/n4K9f9nbGac3W7Am24FvaADgLPs408+fXN/LvizTz/5
mE0MAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOfR/weXSasHxvyVuwAA
AABJRU5ErkJggg==
EOF

base64 --decode > "$RUN/captures/01-invoice-1440-light.png" <<'EOF'
iVBORw0KGgoAAAANSUhEUgAABaAAAAOECAMAAABgk2bgAAAC0FBMVEX8/Pz4+Pjw9PT09PTg4OTM
0NTk5OhUWGQQGCSQlJg8RFAoMDxgZGzc3OCIjJQkKDioqLCgpKyYoKhIVGBUXGzAxMjU1Njk6OjE
xMiUmJyAhIzo6Og4PEg4QEwcIDCkqKyMkJhweIRcZHSosLS8vMSAhJBMVGSMlJyUlJyYnKCcnKTU
2NhMUFy0tLigpKjc3Ny4uLy8wMRsdID09PjEyMxgaHRITFgwNEBwdHyAgIikpKxcYGhQVGCEiJBA
SFCQlJzo7Ow0OERscHisrLRYXGhkbHS8vMBESFTs7OyssLRkbHiEiJTw8PRocHywtLyEjJTIzNBY
YHCQmKDo6OxQXGh4gIhYYGyUnKSIjJi0uMCUmKSMkJxcZHDs7PCIkJjw8PC0uLxsdHzY3Nx0fIi4
vMDIyMxobHSIjJDAwMS0tLywsLh4fIScoKjY2Nzg4OCYnKTQ0NSUmKB0fIRQWGRwdIDk5ORweIDM
0NB0eICcoKTIzMx8gIiwtLhQWGCMjJTU2NyAiJSorLRobHhcYGxkaHCgqKzg5OTc4OCorLDIyNB0
eISkrLDY3ODMzNBgZHDQ1NiMkJSkqLCwsLR8gIz4+Pw4PEwsNEDs8PB4gIx8hIzAwMissLiAiJC8
wMicpKjQ1NRkaHRscHygoKjM2PR0lORQeOAsWNgcTNh4lOiEoOgcUNjU3PQ8aNxEbNzI1PRMdOBU
eOAoWNgwXNiEnOicsOzY4PikuOzo7Pzg6PhsjOTw9Py8zPSIoOj09PyAnOiAmOjc5PgkVNiouPDU
3Pg0YNyUrOzo8PykuPAgUNiUqOzw8PwsXNj4/PywxPC4xPDAzPRcgOBoiOTk6PiMpOhIcNxAaNzo
7Pi4yPBwkOTQ3PiovPB8mOjA0PSQqOzE0PTs8Pzk7Pg4ZNywwPDQ2PSswPAkUNh4mOjU4Ph0kORQ
dOCIpOg8ZNyYsOxghORYfOBIbNz0GX+AAAAse0lEQVR42u3d/2NV530n+M9FQj42CIEfJAMG2VAs
x1/iGCTxJTZgbGxkGfPFEPkbQrbBiRPAwlFCsI3j4CRAYyvENbO262bSbKZR0un33W476Xg3mXa6
7baznXamnU63O52dne7u7M7O/gvbc8690r1CwsKNXQqv1w/mfHuee+858luPnvM850YAAAAAAAAA
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
+9WIv/jf4wfjB/zHsbHfjh9UOz3+KOKv/4+IP4rfjPh38VduEgJ8cAH9nerSb0X81r/8YfzZ2Nj/
GX/1h/EX4wf8s7Gxfxs/yKP5u2NjfxIx9td5bf/0bET8BwEN8MEH9G/ED8Z+dDZ+d2zs/8qP/oXJ
Af39iN/60Z9Hfl/whxHxO9+Z9msOnWqAH2tA/8eIf3824t2xsbGzdeOixwP6u39VVvOfxsb+eX7Y
/x21gR4CGuADDejf+c2Is78U8f+Mjf1lxH8+J6DHfvXXI+Ld/zc/NOKX8v/8pYAG+MACut4f/Ovq
wg+L7uYp/KdfM5MQ4O8goKu+84N8sLOp3gAXXUCfjTj7pwIa4OIL6D/+/e/9tYclAVyEAe1pdgAC
GgABDSCgBTSAgAYQ0AIaQEADXIZ+7UPK519zqgEuzH/5kAL6vzjVABfm+x9SQH/fqQa4MD/8vQ8l
n3/0Q6ca4AL9/ocS0P/ZiQa4YP/fh5DPv+g0A1y4s9//+Q84nn/++2edZoD34zvf+7nvfmDp/N2f
+0ffcYoBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAICL3/8PLsevNxbGwYgAAAAASUVORK5CYII=
EOF

base64 --decode > "$RUN/captures/01-invoice-1440-dark.png" <<'EOF'
iVBORw0KGgoAAAANSUhEUgAABaAAAAOECAMAAABgk2bgAAABm1BMVEUIECAQGCggIDAYIDAQGCAg
KDg4QEjg4ODw8PCwsLjo6Ojo8PDY2NhASFCwuLiQmKCYmKBocHiYoKiQmKhASFgwOEggKDCoqLC4
wMAwOEDo6PAYICiQmJiAiJhYYGhIUFh4gJAQECBweICgqKigoKhQUGDg4OiAiJBISFh4gIiIkJjI
yNDAwMjY2OC4uMAoMEBoaHDI0NBQWGDQ0Njg6OiIkJCIkKBQWGg4QFBocICYmKhweIhgaHB4eIDY
4OCQkJgYGCjQ0NBwcICIiJCAgIhAQFDAyMgoKDhgYHCQkKDIyMiosLCIiJhYYHBYWGjQ2NgwMEBI
UGAoMDhgaHhwcHhgYGhoaHiAgJAYKEA4OEh4eIhYWGCgqLCYoKAYMFA4aKBIgMBYmOhgoPg4YJBY
oPAYKEhQiNhQiNBYoPhIgMhYkOAQGDBIeLgIGChAcKgoSHhQkNhAaKggOGAwUIAoQGgQKEBAeLgY
MEhIeMBQkOAgMFAoSHAoUHhAcLAgOFhYmPAQIDg4YJgwWJBIiNBYmOAgQGAwWIggQGg4WJANMPkU
AAApSElEQVR42u3di3sU15kn4K/RrRCIlo5uSLIk3GAUNRJtBBEXyUbY3IwRBoHjOMnaseLd3MY7
2TiJZyaTxHPL7p+9T1V1t7p1AeGJPQy87/MEd9fldHeV8tPRV+dURwAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAH8blSM9Hc+OHOl9rr37+vscQoCnG8iyo4feeDDLHTs+FHEiyyKyrBpHs2PRm2XDz/Ga
IymlNDq236rxib/BZxrJJp+y9mTW47QD/w1MZVk2/ZwBnWXZTCugX4ujWfacAT2bqnPzp1Lq37vq
9VT71gP69OCM8w78N3Amj9s3Dh/QZxcWhs9m2Uh8b7G2E9CxuNh/6JccS/W8HjKUqv81AQ3w38PZ
bDrLThTFhXPTg0sjEcPLJ6oDg+d7jw5O5zHXODedHX+zHdAXImIl7y/Xly92BPTyci1OLr92dPDS
ZCMivj+QHX9zeXn/UsJqahT/XVztrdQvR0RtMeLKYqpeff1IPV1biJhfTaNXeyPWam+sjl6t1Ear
6xHRszhaXZuJWKk3ZheaOxwc0MPLK8vZ2bdicWAxf62B9Zh/O8suTkVcX96I3vPT2Y13IuLdgWz5
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
5Of5pvmVw+IfAQ3wbQV0p7/8Y/PBH4ty816/+M1nZhIC/BcEdNOX/xTtbrWp3gAvUED/MOL3/y6g
AV68gP63P/30czdLAngBA9rd7AAENAACGkBAC2gAAQ0goAU0gIAGeAX96jvK51851ADP5+++o4D+
O4ca4Pn87DsK6J851ADP5+vPv5N8/uxrhxrgOX35nQT0lw40wHP7t+8gn3/uMAN8Az/7tqscnytA
A3wzn3z608++verzTz/9xCEGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAABefP8fhdSSFv3xTWYAAAAASUVORK5CYII=
EOF
