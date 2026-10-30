#!/usr/bin/env bash
# Puesta en marcha del servidor MCP (/api/mcp) en Azure App Service: tokens por cliente y exclusión de Easy Auth.
#
# Uso:
#   scripts/mcp-setup.sh --exclude-path                  # agrega /api/mcp a las rutas excluidas de Easy Auth (muestra el cambio y pide confirmación)
#   scripts/mcp-setup.sh --exclude-path --dry-run        # solo muestra cómo quedaría, sin escribir
#   scripts/mcp-setup.sh --exclude-path --yes            # sin pregunta de confirmación
#   scripts/mcp-setup.sh <nombre>                        # crea (o ROTA) el token del cliente <nombre> y lo muestra UNA sola vez
#   scripts/mcp-setup.sh --list                          # nombres de los tokens configurados (nunca los valores)
#   scripts/mcp-setup.sh --revoke <nombre>               # revoca el token de ese cliente
#
# <nombre>: minúsculas, dígitos, guion y guion bajo (máx. 30), p. ej. claude, cursor, vscode. Un token por cliente: así revocas uno
# sin tocar los demás. Cada token tiene 48 caracteres aleatorios; la app los compara en tiempo constante.
#
# Destino en Azure (obligatorio): UZ_SUBSCRIPTION, UZ_RG y UZ_APP, ya sea exportadas o en un archivo `.env.azure` en la raíz del repo
# (ignorado por git). Ejemplo en `.env.azure.example`.
#
# Seguridad del script:
#   - El token nuevo se muestra solo si la salida es una terminal (no en un pipe ni en un log) y nunca entra a un argumento de proceso:
#     se escribe en un archivo temporal con permisos 600 que `az` lee con `--settings @archivo`, y se borra al terminar (trap).
#   - Los tokens existentes se leen de Azure a una variable del shell/entorno de python; jamás se imprimen.
#   - Nunca se usa `set -x`; `az ... -o none` evita que `az` repita todas las App Settings en pantalla.
#   - Correrlo en TU terminal, no a través del chat: el token es la llave de tus datos financieros.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$ROOT/.env.azure" ]; then set -a; . "$ROOT/.env.azure"; set +a; fi
SUB="${UZ_SUBSCRIPTION:?Define UZ_SUBSCRIPTION (o créalo en .env.azure; ver .env.azure.example)}"
RG="${UZ_RG:?Define UZ_RG (o créalo en .env.azure)}"
APP="${UZ_APP:?Define UZ_APP (o créalo en .env.azure)}"
MCP_PATH="/api/mcp"
MCP_URL="https://$APP.azurewebsites.net$MCP_PATH"
AUTH_API="2022-03-01"
NAME_RE='^[a-z0-9_-]{1,30}$'

MODE="token"
NAME=""
DRY_RUN=0
ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --exclude-path) MODE="exclude" ;;
    --list) MODE="list" ;;
    --revoke) MODE="revoke"; shift; NAME="${1:-}" ;;
    --dry-run) DRY_RUN=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "Opción desconocida: $1 (usa --help)" >&2; exit 2 ;;
    *) [ -z "$NAME" ] || { echo "Un solo nombre de cliente por ejecución." >&2; exit 2; }; NAME="$1" ;;
  esac
  shift
done

TMP=""
CUR=""
cleanup() {
  [ -n "$TMP" ] && rm -f "$TMP"
  [ -n "$CUR" ] && rm -f "$CUR"
  unset MCP_OLD MCP_NEW MCP_NAME 2>/dev/null || true
}
trap cleanup EXIT
trap 'echo; echo "Interrumpido: se borró el archivo temporal." >&2; exit 130' INT TERM

command -v az >/dev/null 2>&1 || { echo "Falta Azure CLI (az). Instálalo y corre 'az login'." >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "Falta python3 (se usa para mezclar el JSON y los tokens)." >&2; exit 1; }
az account show --subscription "$SUB" --only-show-errors -o none 2>/dev/null || { echo "No hay sesión de Azure para la suscripción $SUB. Corre 'az login'." >&2; exit 1; }

# ─── Modo --exclude-path ─────────────────────────────────────────────────────────────────────────────────────────────────
# Un cliente de IA llama al servidor SIN sesión de Entra, así que /api/mcp debe estar en `excludedPaths` de Easy Auth (igual que
# /api/ingest, /api/ingest/email, /api/whatsapp y /api/telegram). La lista es UNA SOLA propiedad: si se reemplazara en lugar de
# mezclarse, se perderían las rutas ya excluidas y el Atajo, el puente de Gmail y los bots dejarían de funcionar. Por eso: se lee la
# configuración ACTUAL, se agrega la ruta (si falta), se comprueba que no se perdió ninguna y recién entonces se escribe de vuelta.
# La app sigue protegida: el handler exige un token Bearer de MCP_TOKENS (comparado en tiempo constante) y sin tokens rechaza todo.
if [ "$MODE" = "exclude" ]; then
  URI="/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.Web/sites/$APP/config/authsettingsV2"
  TMP="$(mktemp)"; chmod 600 "$TMP"
  CUR="$(mktemp)"; chmod 600 "$CUR"

  az rest --method get --uri "$URI/list?api-version=$AUTH_API" --only-show-errors -o json > "$CUR"

  # Imprime "antes|después" y escribe en $TMP el cuerpo para el PUT. Sale 3 si la ruta ya estaba y 4 si el merge perdería algo.
  set +e
  RESULT="$(CUR="$CUR" TMP="$TMP" WP="$MCP_PATH" python3 - <<'PY'
import json, os, sys
doc = json.load(open(os.environ["CUR"]))
props = doc.get("properties") or {}
gv = props.setdefault("globalValidation", {})
before = list(gv.get("excludedPaths") or [])
wp = os.environ["WP"]
after = before + ([wp] if wp not in before else [])
missing = [p for p in before if p not in after]
if missing:
    sys.exit(4)
gv["excludedPaths"] = after
json.dump({"properties": props}, open(os.environ["TMP"], "w"))
print(json.dumps(before) + "|" + json.dumps(after))
sys.exit(3 if wp in before else 0)
PY
)"
  RC=$?
  set -e
  [ "$RC" = "4" ] && { echo "Abortado: la mezcla perdería rutas excluidas existentes. No se cambió nada." >&2; exit 1; }
  BEFORE="${RESULT%%|*}"; AFTER="${RESULT#*|}"
  echo "Rutas excluidas de Easy Auth ahora : $BEFORE"
  echo "Quedarían                          : $AFTER"
  if [ "$RC" = "3" ]; then echo "$MCP_PATH ya estaba excluida: no hay nada que hacer."; exit 0; fi
  if [ "$DRY_RUN" = "1" ]; then echo "(--dry-run: no se escribió nada)"; exit 0; fi
  if [ "$ASSUME_YES" != "1" ]; then
    read -r -p "¿Aplicar el cambio en $APP? [s/N] " ans
    case "$ans" in s|S|si|SI|sí|y|Y) ;; *) echo "Cancelado."; exit 0 ;; esac
  fi
  az rest --method put --uri "$URI?api-version=$AUTH_API" --body "@$TMP" --only-show-errors -o none
  echo "Listo. Verifica (deben seguir todas las rutas que ya había, más $MCP_PATH):"
  echo "  az rest --method get --uri \"$URI/list?api-version=$AUTH_API\" --subscription $SUB --query properties.globalValidation.excludedPaths -o tsv"
  echo "Prueba sin token (debe ser 401 de la app con {\"error\":\"No autorizado\"}, NO una redirección 302 de Easy Auth):"
  echo "  curl -s -i -X POST \"$MCP_URL\" -H 'content-type: application/json' -d '{}' | head -12"
  exit 0
fi

# Lee un App Setting de Azure a stdout sin mostrarlo (se captura en una variable); vacío si no existe.
az_setting() {
  az webapp config appsettings list --subscription "$SUB" --resource-group "$RG" --name "$APP" \
    --query "[?name=='$1'].value | [0]" -o tsv --only-show-errors 2>/dev/null | grep -v '^None$' || true
}

# ─── Modo --list ─────────────────────────────────────────────────────────────────────────────────────────────────────────
MCP_OLD="$(az_setting MCP_TOKENS)"
export MCP_OLD
if [ "$MODE" = "list" ]; then
  if [ -z "$MCP_OLD" ]; then echo "No hay tokens MCP en $APP: /api/mcp rechaza todo."; exit 0; fi
  python3 -c 'import os; print("\n".join(p.split("=")[0].strip() for p in os.environ["MCP_OLD"].split(",") if p.strip()))'
  exit 0
fi

# ─── Modos token y --revoke ──────────────────────────────────────────────────────────────────────────────────────────────
[ -n "$NAME" ] || { echo "Falta el nombre del cliente (p. ej. claude). Usa --help." >&2; exit 2; }
[[ "$NAME" =~ $NAME_RE ]] || { echo "Nombre inválido: solo minúsculas, dígitos, guion y guion bajo (máx. 30)." >&2; exit 2; }
export MCP_NAME="$NAME"

if [ "$MODE" = "token" ]; then
  [ -t 1 ] || { echo "La salida no es una terminal: el token nuevo se muestra una sola vez y no debe ir a un pipe ni a un log. Corre esto en tu terminal." >&2; exit 1; }
  command -v openssl >/dev/null 2>&1 || { echo "Falta openssl (genera el token)." >&2; exit 1; }
  MCP_NEW="$(openssl rand -base64 48 | tr -d '=+/\n' | cut -c1-48)"
  [ "${#MCP_NEW}" = "48" ] || { echo "No se pudo generar el token." >&2; exit 1; }
  export MCP_NEW
fi

TMP="$(mktemp)"; chmod 600 "$TMP"
# Mezcla: conserva los demás tokens tal cual, reemplaza (o agrega) el de $NAME o lo quita (--revoke). Sale 3 si no había nada que revocar.
set +e
MODE="$MODE" python3 - "$TMP" <<'PY'
import json, os, re, sys
name = os.environ["MCP_NAME"]
mode = os.environ["MODE"]
parts = [p.strip() for p in os.environ.get("MCP_OLD", "").split(",") if p.strip()]
kept = [p for p in parts if p.split("=", 1)[0] != name]
existed = len(kept) != len(parts)
if mode == "revoke":
    if not existed:
        sys.exit(3)
    new = kept
else:
    new = kept + ["%s=%s" % (name, os.environ["MCP_NEW"])]
for p in new:
    n, _, t = p.partition("=")
    if not re.fullmatch(r"[a-z0-9_-]{1,30}", n) or len(t) < 32:
        sys.exit(4)
json.dump([{"name": "MCP_TOKENS", "value": ",".join(new), "slotSetting": False}], open(sys.argv[1], "w"))
PY
RC=$?
set -e
[ "$RC" = "3" ] && { echo "No existe el cliente '$NAME' (usa --list). No se cambió nada."; exit 0; }
[ "$RC" = "4" ] && { echo "Los tokens guardados en Azure no tienen el formato nombre=token (≥ 32). Revísalos a mano; no se cambió nada." >&2; exit 1; }

if [ "$MODE" = "revoke" ] && [ "$ASSUME_YES" != "1" ]; then
  read -r -p "¿Revocar el token de '$NAME'? Ese cliente dejará de poder consultar tus datos. [s/N] " ans
  case "$ans" in s|S|si|SI|sí|y|Y) ;; *) echo "Cancelado."; exit 0 ;; esac
fi

echo "Aplicando App Settings (la app se reinicia unos segundos)…"
az webapp config appsettings set --subscription "$SUB" --resource-group "$RG" --name "$APP" --settings "@$TMP" --only-show-errors -o none
rm -f "$TMP"; TMP=""

if [ "$MODE" = "revoke" ]; then
  echo "Token de '$NAME' revocado: desde el reinicio ese cliente recibe 401."
  exit 0
fi

echo
echo "Token de '$NAME' (se muestra UNA sola vez; guárdalo en el gestor de contraseñas de tu cliente, no en el repo ni en el chat):"
echo
echo "  $MCP_NEW"
echo
echo "URL del servidor: $MCP_URL"
echo "Requisitos: este código ya desplegado (push a main) y la ruta excluida de Easy Auth (scripts/mcp-setup.sh --exclude-path)."
echo "Cómo conectar Claude Code, Cursor, VS Code o Claude Desktop: docs/GUIA.md (sección «Servidor MCP»)."
