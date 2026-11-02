#!/usr/bin/env bash
# run-apps.sh up [--profile <name>] | down | status
# Starts every app with a run-scoped env built from setup.json profiles (default merged with the named one). `api: null` = don't start it.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUN_ID="$(cat "$ROOT/.factory/runs/ACTIVE")"; RUN="$ROOT/.factory/runs/$RUN_ID"
LOGS="$RUN/app-logs"; mkdir -p "$LOGS" "$RUN/profile-data"
API_PORT="${API_PORT:-8787}"; WEB_PORT="${WEB_PORT:-5173}"
PROFILE="default"; [ "${1:-}" = "up" ] && [ "${2:-}" = "--profile" ] && PROFILE="${3:-default}"
health() { curl -fsS -m 2 "$1" >/dev/null 2>&1; }
wait_for() { local url="$1" n=0; until health "$url"; do n=$((n+1)); [ "$n" -ge 60 ] && return 1; sleep 0.5; done; }
# env for an app: "KEY=VAL" lines, or the single word SKIP when the profile disables the app
app_env() { node -e '
  const [setup, profile, app, run] = process.argv.slice(1);
  const s = JSON.parse(require("fs").readFileSync(setup, "utf8")); const p = s.profiles || {};
  if (!(profile in p)) { console.error("unknown profile " + profile); process.exit(3); }
  const merged = Object.assign({}, (p.default || {})[app] || {});
  if (profile !== "default") { const o = (p[profile] || {})[app]; if (o === null) { console.log("SKIP"); process.exit(0); } Object.assign(merged, o || {}); }
  for (const [k, v] of Object.entries(merged)) console.log(k + "=" + String(v).replaceAll("{run}", run));
' "$ROOT/.factory/setup.json" "$PROFILE" "$1" "$RUN"; }
case "${1:-status}" in
  up)
    "$0" down >/dev/null 2>&1 || true
    api_ok=skip; web_ok=skip
    API_ENV="$(app_env api)" || exit 3
    if [ "$API_ENV" != "SKIP" ]; then
      ( cd "$ROOT/apps/api" && env -i PATH="$PATH" HOME="$HOME" NODE_ENV=development PORT="$API_PORT" $API_ENV pnpm run start >"$LOGS/api.log" 2>&1 & )
      api_ok=false; wait_for "http://localhost:$API_PORT/api/health" && api_ok=true
    fi
    WEB_ENV="$(app_env web)" || exit 3
    if [ "$WEB_ENV" != "SKIP" ]; then
      ( cd "$ROOT/apps/web" && env -i PATH="$PATH" HOME="$HOME" NODE_ENV=development $WEB_ENV pnpm run dev -- --port "$WEB_PORT" --strictPort >"$LOGS/web.log" 2>&1 & )
      web_ok=false; wait_for "http://localhost:$WEB_PORT/" && web_ok=true
    fi
    printf '{ "profile": "%s", "api": { "url": "http://localhost:%s", "ok": "%s", "env": %s }, "web": { "url": "http://localhost:%s", "ok": "%s", "env": %s }, "logs": "%s", "started_at": "%s" }\n' \
      "$PROFILE" "$API_PORT" "$api_ok" "$(printf '%s' "$API_ENV" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(s.trim())))')" \
      "$WEB_PORT" "$web_ok" "$(printf '%s' "$WEB_ENV" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(s.trim())))')" "$LOGS" "$(date -Iseconds)" > "$RUN/apps.json"
    echo "APPS profile=$PROFILE api=$api_ok web=$web_ok"; [ "$api_ok" != false ] && [ "$web_ok" != false ] ;;
  down)
    fuser -k -TERM "$API_PORT/tcp" "$WEB_PORT/tcp" >/dev/null 2>&1; sleep 0.5; fuser -k -KILL "$API_PORT/tcp" "$WEB_PORT/tcp" >/dev/null 2>&1; echo "APPS down" ;;
  status) health "http://localhost:$API_PORT/api/health" && echo "api up" || echo "api down"; health "http://localhost:$WEB_PORT/" && echo "web up" || echo "web down" ;;
esac
