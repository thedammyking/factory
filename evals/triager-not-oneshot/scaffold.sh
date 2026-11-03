set -e
git init -q -b main
git config user.name eval
git config user.email eval@example.com
git config commit.gpgsign false
mkdir -p .factory/runs/r1 web/src api/src

cat > .gitignore <<'EOF'
.factory/runs/
.factory/worktrees/
.factory/env.local
EOF

cat > .factory/config.json <<'EOF'
{ "branching": { "model": "trunk", "main": "main", "prefixes": { "feature": "feature/", "bugfix": "bugfix/", "hotfix": "hotfix/" } } }
EOF

cat > .factory/setup.json <<'EOF'
{ "apps": [
  { "name": "web", "type": "web", "path": "web", "checks": { "test": "npm test" } },
  { "name": "api", "type": "backend", "path": "api", "checks": { "test": "node --test" } }
] }
EOF

cat > web/package.json <<'EOF'
{ "name": "acme-web", "type": "module", "dependencies": { "react": "19.2.0" }, "scripts": { "test": "node --test" } }
EOF

cat > web/src/ProfileCard.jsx <<'EOF'
import { useEffect, useState } from "react";

export function ProfileCard({ userId }) {
  const [user, setUser] = useState(null);
  useEffect(() => {
    fetch(`/api/users/${userId}/profile`).then((r) => r.json()).then(setUser);
  }, [userId]);
  if (!user) return <p>Loading…</p>;
  return (
    <section className="profile-card">
      <h2>{user.name}</h2>
      <p>{user.email}</p>
    </section>
  );
}
EOF

cat > api/package.json <<'EOF'
{ "name": "acme-api", "type": "module", "scripts": { "start": "node src/server.js", "test": "node --test" } }
EOF

cat > api/src/db.js <<'EOF'
const users = [{ id: "1", name: "Ada Lovelace", email: "ada@example.com", timezone: "Europe/London", passwordHash: "x" }];
export const findUser = (id) => users.find((u) => u.id === id);
EOF

cat > api/src/server.js <<'EOF'
import http from "node:http";
import { findUser } from "./db.js";

http.createServer((req, res) => {
  const m = req.url.match(/^\/api\/users\/([^/]+)\/profile$/);
  const user = m && findUser(m[1]);
  if (!user) { res.statusCode = 404; return res.end(); }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ name: user.name, email: user.email }));
}).listen(process.env.PORT || 4000);
EOF

cat > .factory/runs/r1/prompt.md <<'EOF'
Show the user's timezone on their profile card.
EOF

git add -A
git commit -qm "Show a profile card"
