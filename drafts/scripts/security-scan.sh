#!/usr/bin/env bash
# security-scan.sh <base_sha> -> security.json
# Capabilities, each satisfied by whichever tool is available (first that runs wins); a capability with no tool is `missing`,
# never a pass. Registry packs for semgrep are `partial` when the registry is unreachable; project rules always run.
set -u; ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; RUN="$ROOT/.factory/runs/$(cat "$ROOT/.factory/runs/ACTIVE")"; BASE="$1"; cd "$ROOT"
j() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s)))'; }
caps=()
rec() { caps+=("{\"capability\":\"$1\",\"tool\":\"$2\",\"status\":\"$3\",\"detail\":$(printf '%s' "$4" | tail -c 600 | j)}"); }

# --- secrets: gitleaks (preferred) or secretlint (npm) on the files changed in this branch
if command -v gitleaks >/dev/null 2>&1; then
  out=$(gitleaks git --no-banner --redact --log-opts="$BASE..HEAD" . 2>&1); rc=$?; rec secrets gitleaks "$([ $rc -eq 0 ] && echo pass || echo fail)" "$out"
else
  files=$(git diff --name-only "$BASE..HEAD" -- . ':(exclude)pnpm-lock.yaml' | tr '\n' ' ')
  if [ -n "$files" ]; then
    out=$(timeout 300 npx -y -p secretlint -p @secretlint/secretlint-rule-preset-recommend secretlint --secretlintrc <(echo '{"rules":[{"id":"@secretlint/secretlint-rule-preset-recommend"}]}') $files 2>&1); rc=$?
    rec secrets secretlint "$([ $rc -eq 0 ] && echo pass || echo fail)" "$out"
  else rec secrets secretlint pass "no changed files"; fi
fi

# --- vulnerabilities: pnpm/npm audit (required) + osv-scanner (optional second source)
if [ -f pnpm-lock.yaml ]; then out=$(pnpm audit --audit-level=high --prod 2>&1); rc=$?; rec vulnerabilities pnpm-audit "$([ $rc -eq 0 ] && echo pass || echo fail)" "$out"
else out=$(npm audit --audit-level=high --omit=dev 2>&1); rc=$?; rec vulnerabilities npm-audit "$([ $rc -eq 0 ] && echo pass || echo fail)" "$out"; fi
if command -v osv-scanner >/dev/null 2>&1; then out=$(osv-scanner scan source -r . 2>&1); rc=$?; rec vulnerabilities-2nd-source osv-scanner "$([ $rc -eq 0 ] && echo pass || echo fail)" "$out"
else rec vulnerabilities-2nd-source osv-scanner optional "not installed (brew install osv-scanner)"; fi

# --- SAST: semgrep project rules (always) + registry packs (when the registry is reachable)
if command -v semgrep >/dev/null 2>&1; then
  out=$(timeout 600 semgrep scan --config .factory/semgrep/project.yaml --metrics=off --error --baseline-commit "$BASE" --quiet --json apps 2>/dev/null); rc=$?
  n=$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s);console.log(r.results.length)}catch{console.log("?")}})')
  rec sast-project-rules semgrep "$([ $rc -eq 0 ] && echo pass || echo fail)" "findings=$n"
  printf '%s' "$out" > "$RUN/semgrep-project.json"
  out=$(timeout 600 semgrep scan --config p/typescript --config p/nodejs --config p/react --config p/owasp-top-ten --metrics=off --error --baseline-commit "$BASE" --quiet --json apps 2>/dev/null); rc=$?
  if printf '%s' "$out" | grep -q '"results"'; then
    n=$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(r.results.length)})')
    rec sast-registry-packs semgrep "$([ $rc -eq 0 ] && echo pass || echo fail)" "findings=$n"; printf '%s' "$out" > "$RUN/semgrep-packs.json"
  else rec sast-registry-packs semgrep partial "semgrep.dev registry unreachable from this environment; project rules ran"; fi
else rec sast-project-rules semgrep missing "not installed (pip install semgrep / brew install semgrep)"; fi

# --- two checks no scanner does
pub=$(git diff "$BASE..HEAD" -- apps | grep -E '^\+.*(VITE|NEXT_PUBLIC)_[A-Z_]+' | grep -oE '(VITE|NEXT_PUBLIC)_[A-Z_]+' | sort -u | tr '\n' ' ')
newdeps=$(git diff "$BASE..HEAD" -- 'apps/*/package.json' package.json | grep -E '^\+\s+"[^"]+":\s*"[~^0-9]' | sed -E 's/^\+\s+"([^"]+)".*/\1/' | sort -u | tr '\n' ' ')
printf '{ "base": "%s", "head": "%s", "capabilities": [%s], "client_exposed_env": "%s", "new_dependencies": "%s", "findings": [] }\n' \
  "$BASE" "$(git rev-parse HEAD)" "$(IFS=,; echo "${caps[*]}")" "$pub" "$newdeps" > "$RUN/security.json"
node -e "const s=require('$RUN/security.json');console.log('SECURITY '+s.capabilities.map(c=>c.capability+'='+c.status+'('+c.tool+')').join(' ')+' | client env: '+s.client_exposed_env+'| new deps: '+s.new_dependencies.split(' ').filter(Boolean).length)"
