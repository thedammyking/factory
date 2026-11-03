set -e
git init -q -b main
git config user.name eval
git config user.email eval@example.com
git config commit.gpgsign false
mkdir -p .factory/runs/r1 src

cat > .gitignore <<'EOF'
.factory/runs/
.factory/worktrees/
.factory/env.local
EOF

cat > .factory/config.json <<'EOF'
{ "branching": { "model": "trunk", "main": "main", "prefixes": { "feature": "feature/", "bugfix": "bugfix/", "hotfix": "hotfix/" } } }
EOF

cat > .factory/setup.json <<'EOF'
{ "apps": [{ "name": "web", "type": "web", "path": ".", "checks": { "test": "node --test" } }] }
EOF

cat > package.json <<'EOF'
{ "name": "acme-dashboard", "type": "module", "scripts": { "start": "node src/server.js", "test": "node --test" } }
EOF

cat > README.md <<'EOF'
# acme-dashboard

The team's metrics dashboard: one page, served at /dashboard.
EOF

cat > src/server.js <<'EOF'
import http from "node:http";
import { renderDashboard } from "./dashboard.js";

http.createServer((req, res) => {
  if (req.url === "/dashboard") {
    res.setHeader("content-type", "text/html");
    return res.end(renderDashboard());
  }
  res.statusCode = 404;
  res.end("not found");
}).listen(process.env.PORT || 3000);
EOF

cat > src/dashboard.js <<'EOF'
import { metrics } from "./metrics.js";

export function renderDashboard() {
  const rows = metrics().map((m) => `<li>${m.name}: ${m.value}</li>`).join("");
  return `<h1>Team dashboard</h1><ul>${rows}</ul>`;
}
EOF

cat > src/metrics.js <<'EOF'
export const metrics = () => [
  { name: "Open tickets", value: 42 },
  { name: "Deploys this week", value: 7 },
  { name: "Error rate", value: "0.4%" },
];
EOF

cat > .factory/runs/r1/prompt.md <<'EOF'
Make the dashboard better.
EOF

git add -A
git commit -qm "Serve the team dashboard"
