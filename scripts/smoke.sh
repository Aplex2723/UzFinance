#!/usr/bin/env bash
# Smoke test post-despliegue. Uso: scripts/smoke.sh https://<app>.azurewebsites.net [INGEST_TOKEN]
# Verifica lo observable sin sesión: el login es obligatorio y /api/ingest exige token.
set -uo pipefail
BASE="${1:?uso: smoke.sh <base-url> [token]}"
TOKEN="${2:-}"
fail=0
ok()   { echo "  ✓ $1"; }
bad()  { echo "  ✗ $1"; fail=1; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 90 "$@"; }

echo "Esperando a que la app responda (arranque en frío del plan F1)…"
for i in $(seq 1 30); do
  c=$(code -X POST "$BASE/api/ingest"); [ "$c" != "000" ] && [ "$c" != "502" ] && [ "$c" != "503" ] && [ "$c" != "504" ] && break
  sleep 10
done
[ "$c" = "401" ] && ok "POST /api/ingest sin token → 401" || bad "POST /api/ingest sin token → $c (esperado 401)"

c=$(code -X POST -H 'Content-Type: application/json' -H 'Authorization: Bearer invalido-invalido-invalido-invalido-1234' -d '{}' "$BASE/api/ingest")
[ "$c" = "401" ] && ok "token inválido → 401" || bad "token inválido → $c"

# Easy Auth: un navegador sin sesión recibe 302 al login de Entra; un cliente que no lo parece, 401.
read -r c loc < <(curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' --max-time 90 -H 'Accept: text/html,application/xhtml+xml' -H 'User-Agent: Mozilla/5.0 (smoke-test)' "$BASE/")
if [ "$c" = "302" ] && [[ "$loc" == *"login.microsoftonline.com"* ]]; then ok "GET / sin sesión (navegador) → 302 al login de Entra"; else bad "GET / sin sesión (navegador) → $c ${loc:0:80}"; fi

hdr=$(curl -s -D - -o /dev/null --max-time 90 "$BASE/")
if echo "$hdr" | head -1 | grep -q " 401" && echo "$hdr" | grep -qi '^www-authenticate: Bearer'; then ok "GET / sin sesión (cliente no navegador) → 401 de Easy Auth"; else bad "GET / sin sesión (cliente no navegador) no fue 401 de Easy Auth"; fi

c=$(code "$BASE/api/transactions")
[ "$c" = "302" ] || [ "$c" = "401" ] && ok "GET /api/transactions sin sesión → $c" || bad "GET /api/transactions sin sesión → $c (¡expuesto!)"

c=$(code "$BASE/.auth/login/google")
[ "$c" != "200" ] && [ "$c" != "302" ] && ok "otros proveedores de login deshabilitados ($c)" || bad "/.auth/login/google responde $c"

if [ -n "$TOKEN" ]; then
  c=$(code -X POST -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" -H 'X-Dry-Run: 1' -d '{"merchant":"SMOKE","amount":"1","card":"smoke"}' "$BASE/api/ingest")
  [ "$c" = "200" ] && ok "ingesta con token válido (dry-run) → 200" || bad "ingesta con token válido → $c"
fi
exit $fail
