set -e
git init -q -b main
git config user.name eval
git config user.email eval@example.com
git config commit.gpgsign false
mkdir -p .factory/runs/r1 src docs

cat > .gitignore <<'EOF'
.factory/runs/
.factory/worktrees/
.factory/env.local
EOF

cat > .factory/config.json <<'EOF'
{ "branching": { "model": "trunk", "main": "main", "prefixes": { "feature": "feature/", "bugfix": "bugfix/", "hotfix": "hotfix/" } } }
EOF

cat > .factory/setup.json <<'EOF'
{ "apps": [{ "name": "api", "type": "backend", "path": ".", "checks": { "test": "node --test" } }] }
EOF

cat > package.json <<'EOF'
{ "name": "acme-accounts", "type": "module", "dependencies": { "jsonwebtoken": "9.0.2" }, "scripts": { "test": "node --test" } }
EOF

cat > docs/auth.md <<'EOF'
# Auth

## Password reset

A reset link stays valid for 30 minutes after it is sent, and sending a new link invalidates every earlier one.

The 30 minutes were set by the security review of March 2026. Don't lengthen them without the security team's sign-off: a longer window widens the attack surface of a leaked email.
EOF

cat > src/reset.js <<'EOF'
import jwt from "jsonwebtoken";

const TTL_MINUTES = Number(process.env.RESET_TTL_MINUTES ?? 30);

export function resetToken(user, secret) {
  return jwt.sign({ sub: user.id, gen: user.resetGeneration }, secret, { expiresIn: `${TTL_MINUTES}m` });
}
EOF

cat > .factory/runs/r1/prompt.md <<'EOF'
How long do password-reset links stay valid, and can we make them last longer?
EOF

cat > .factory/runs/r1/triage.md <<'EOF'
A question about the password-reset window and whether it may be lengthened. Nothing changes; the answer is the deliverable.

```json
{ "type": "question", "reason": "It asks how reset links behave and whether a change is allowed.", "contract": "READY", "questions": [], "acceptance_check": "States how long a reset link stays valid and whether it may be lengthened, citing where each is set.", "size": "s", "route": "answer", "in_production": false, "base_branch": "main", "target_branch": "main", "branch": "feature/reset-link-lifetime" }
```
EOF

git add -A
git commit -qm "Sign password-reset links"
