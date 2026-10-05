#!/usr/bin/env bash
# Puesta en marcha del bot de WhatsApp (Meta Cloud API) en Azure App Service.
#
# Uso:
#   scripts/whatsapp-setup.sh                       # pide los datos y los guarda como App Settings
#   scripts/whatsapp-setup.sh --exclude-path        # agrega /api/whatsapp a las rutas excluidas de Easy Auth (muestra el cambio y pide confirmación)
#   scripts/whatsapp-setup.sh --exclude-path --dry-run   # solo muestra cómo quedaría, sin escribir
#   scripts/whatsapp-setup.sh --exclude-path --yes       # sin pregunta de confirmación
#
# Variables opcionales (por omisión, los datos de producción de UzFinance):
#   UZ_SUBSCRIPTION  UZ_RG  UZ_APP
#
# Seguridad del script:
#   - Los secretos (token de acceso y App Secret) se piden con `read -s`: no se ven en pantalla, no entran al historial del shell
#     ni pasan por el chat.
#   - Se escriben en un archivo temporal con permisos 600 y se pasan a `az` como `--settings @archivo`, así NO aparecen en la
#     lista de procesos (`ps`). El archivo se borra al terminar (trap), incluso si algo falla o se interrumpe.
#   - Nunca se usa `set -x` ni se imprimen secretos; `az ... -o none` evita que `az` repita todas las App Settings en pantalla.
#   - Al final solo se imprimen la URL del webhook y el verify token (que debes pegar en la consola de Meta).
set -euo pipefail
umask 077

SUB="${UZ_SUBSCRIPTION:-61c871ca-30f7-43ef-a9c7-910fa8c0a5a5}"
RG="${UZ_RG:-rg-uzfinance}"
APP="${UZ_APP:-uzfinance-092d5}"
WEBHOOK_PATH="/api/whatsapp"
AUTH_API="2022-03-01"

MODE="settings"
DRY_RUN=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --exclude-path) MODE="exclude" ;;
    --dry-run) DRY_RUN=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Opción desconocida: $arg (usa --help)" >&2; exit 2 ;;
  esac
done

TMP=""
cleanup() {
  [ -n "$TMP" ] && rm -f "$TMP"
  unset WA_ACCESS_TOKEN WA_APP_SECRET WA_VERIFY_TOKEN WA_PHONE_ID WA_ALLOWED WA_VERSION 2>/dev/null || true
}
trap cleanup EXIT
trap 'echo; echo "Interrumpido: se borró el archivo temporal." >&2; exit 130' INT TERM

command -v az >/dev/null 2>&1 || { echo "Falta Azure CLI (az). Instálalo y corre 'az login'." >&2; exit 1; }
az account show --subscription "$SUB" --only-show-errors -o none 2>/dev/null || { echo "No hay sesión de Azure para la suscripción $SUB. Corre 'az login'." >&2; exit 1; }

# ─── Modo --exclude-path ─────────────────────────────────────────────────────────────────────────────────────────────────
# Meta llama al webhook SIN sesión de Entra, así que /api/whatsapp debe estar en `excludedPaths` de Easy Auth (igual que
# /api/ingest y /api/ingest/email). La lista es UNA SOLA propiedad: si se reemplazara en lugar de mezclarse, se perderían las
# rutas que ya estaban excluidas (hoy /api/ingest, /api/ingest/email, /manifest.webmanifest, /icons/*) y el Atajo de Wallet, el
# puente de Gmail o la instalación en el celular dejarían de funcionar. Por eso: se lee la configuración ACTUAL, se agrega la ruta
# (si falta), se comprueba que no se perdió ninguna y recién entonces se escribe todo el objeto de vuelta con PUT.
# La app sigue protegida: el handler exige el verify token (GET) y la firma HMAC de Meta (POST).
if [ "$MODE" = "exclude" ]; then
  command -v python3 >/dev/null 2>&1 || { echo "Falta python3 (se usa para mezclar el JSON)." >&2; exit 1; }
  URI="/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.Web/sites/$APP/config/authsettingsV2"
  TMP="$(mktemp)"; chmod 600 "$TMP"
  CUR="$(mktemp)"; chmod 600 "$CUR"
  trap 'rm -f "$TMP" "$CUR"; cleanup' EXIT

  az rest --method get --uri "$URI/list?api-version=$AUTH_API" --only-show-errors -o json > "$CUR"

  # Imprime "antes|después" y escribe en $TMP el cuerpo para el PUT. Sale 3 si la ruta ya estaba y 4 si el merge perdería algo.
  set +e
  RESULT="$(CUR="$CUR" TMP="$TMP" WP="$WEBHOOK_PATH" python3 - <<'PY'
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
  if [ "$RC" = "3" ]; then echo "$WEBHOOK_PATH ya estaba excluida: no hay nada que hacer."; exit 0; fi
  if [ "$DRY_RUN" = "1" ]; then echo "(--dry-run: no se escribió nada)"; exit 0; fi
  if [ "$ASSUME_YES" != "1" ]; then
    read -r -p "¿Aplicar el cambio en $APP? [s/N] " ans
    case "$ans" in s|S|si|SI|sí|y|Y) ;; *) echo "Cancelado."; exit 0 ;; esac
  fi
  az rest --method put --uri "$URI?api-version=$AUTH_API" --body "@$TMP" --only-show-errors -o none
  echo "Listo. Verifica (debe incluir las 5 rutas):"
  echo "  az rest --method get --uri \"$URI/list?api-version=$AUTH_API\" --subscription $SUB --query properties.globalValidation.excludedPaths -o tsv"
  echo "Prueba sin sesión (debe ser 403, NO 302/401 de Easy Auth):"
  echo "  curl -s -o /dev/null -w '%{http_code}\\n' \"https://$APP.azurewebsites.net$WEBHOOK_PATH\""
  exit 0
fi

# ─── Modo normal: App Settings ───────────────────────────────────────────────────────────────────────────────────────────
command -v openssl >/dev/null 2>&1 || { echo "Falta openssl (genera el verify token)." >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "Falta python3 (arma el JSON de ajustes sin pasar secretos por argumentos)." >&2; exit 1; }

echo "Configuración del bot de WhatsApp para $APP (grupo $RG)."
echo "Los secretos no se muestran al escribirlos. Nada de esto se guarda en el historial."
echo

read -r -s -p "Token de acceso permanente (usuario del sistema de Meta): " WA_ACCESS_TOKEN; echo
WA_ACCESS_TOKEN="$(printf '%s' "$WA_ACCESS_TOKEN" | tr -d '[:space:]')"
[ "${#WA_ACCESS_TOKEN}" -ge 20 ] && [[ "$WA_ACCESS_TOKEN" =~ ^[A-Za-z0-9_.~+/=-]+$ ]] || { echo "Token de acceso inválido (≥ 20 caracteres, sin espacios)." >&2; exit 1; }

read -r -s -p "App Secret (Configuración de la app → Básica): " WA_APP_SECRET; echo
WA_APP_SECRET="$(printf '%s' "$WA_APP_SECRET" | tr -d '[:space:]')"
[ "${#WA_APP_SECRET}" -ge 16 ] && [[ "$WA_APP_SECRET" =~ ^[A-Za-z0-9_.~+/=-]+$ ]] || { echo "App Secret inválido (≥ 16 caracteres, sin espacios)." >&2; exit 1; }

read -r -p "Phone number ID (WhatsApp → Configuración de la API; solo dígitos): " WA_PHONE_ID
WA_PHONE_ID="$(printf '%s' "$WA_PHONE_ID" | tr -d '[:space:]')"
[[ "$WA_PHONE_ID" =~ ^[0-9]{5,25}$ ]] || { echo "Phone number ID inválido (5 a 25 dígitos)." >&2; exit 1; }

echo "Números autorizados, con lada de país y sin +: 525512345678=Uziel,525587654321=Ana (de 1 a 5 personas)."
read -r -p "Autorizados: " WA_ALLOWED
WA_ALLOWED="$(printf '%s' "$WA_ALLOWED" | sed -e 's/[[:space:]]*,[[:space:]]*/,/g' -e 's/[[:space:]]*=[[:space:]]*/=/g' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
IFS=',' read -r -a ENTRIES <<< "$WA_ALLOWED"
[ "${#ENTRIES[@]}" -ge 1 ] && [ "${#ENTRIES[@]}" -le 5 ] || { echo "Debe haber entre 1 y 5 personas." >&2; exit 1; }
NAME_RE="^[[:alpha:] .'-]{1,30}\$"
SEEN=""
for e in "${ENTRIES[@]}"; do
  num="${e%%=*}"; name="${e#*=}"
  [[ "$e" == *"="* ]] || { echo "Formato inválido (falta '='): usa número=Nombre." >&2; exit 1; }
  num="${num#+}"
  [[ "$num" =~ ^[1-9][0-9]{10,14}$ ]] || { echo "Número inválido (11 a 15 dígitos, con lada de país, sin 0 inicial; ej. 525512345678): $num" >&2; exit 1; }
  [[ "$name" =~ $NAME_RE ]] || { echo "Nombre inválido (solo letras, espacio, punto, apóstrofo o guion; máx. 30): $name" >&2; exit 1; }
  # Se compara el número COMPLETO; solo en México 521+10 dígitos equivale a 52+10 dígitos (igual que el webhook).
  canon="$num"; [[ "$num" =~ ^521[0-9]{10}$ ]] && canon="52${num:3}"
  case ",$SEEN," in *",$canon,"*) echo "Número repetido: $num" >&2; exit 1 ;; esac
  SEEN="$SEEN,$canon"
done
# Se guarda sin "+" ni espacios alrededor del número.
WA_ALLOWED="$(printf '%s' "$WA_ALLOWED" | sed 's/+//g')"

WA_VERSION="${UZ_GRAPH_VERSION:-v25.0}"
WA_VERIFY_TOKEN="$(openssl rand -hex 24)"
export WA_ACCESS_TOKEN WA_APP_SECRET WA_VERIFY_TOKEN WA_PHONE_ID WA_ALLOWED WA_VERSION

TMP="$(mktemp)"; chmod 600 "$TMP"
python3 - "$TMP" <<'PY'
import json, os, sys
settings = [
    {"name": "WHATSAPP_VERIFY_TOKEN", "value": os.environ["WA_VERIFY_TOKEN"], "slotSetting": False},
    {"name": "WHATSAPP_APP_SECRET", "value": os.environ["WA_APP_SECRET"], "slotSetting": False},
    {"name": "WHATSAPP_ACCESS_TOKEN", "value": os.environ["WA_ACCESS_TOKEN"], "slotSetting": False},
    {"name": "WHATSAPP_PHONE_NUMBER_ID", "value": os.environ["WA_PHONE_ID"], "slotSetting": False},
    {"name": "WHATSAPP_ALLOWED", "value": os.environ["WA_ALLOWED"], "slotSetting": False},
    {"name": "WHATSAPP_GRAPH_VERSION", "value": os.environ["WA_VERSION"], "slotSetting": False},
]
with open(sys.argv[1], "w") as f:
    json.dump(settings, f)
PY

echo
echo "Aplicando App Settings (la app se reinicia unos segundos)…"
az webapp config appsettings set --subscription "$SUB" --resource-group "$RG" --name "$APP" --settings "@$TMP" --only-show-errors -o none
rm -f "$TMP"; TMP=""

echo
echo "Listo. En la consola de Meta (WhatsApp → Configuración → Webhook) pega:"
echo "  URL de devolución de llamada : https://$APP.azurewebsites.net$WEBHOOK_PATH"
echo "  Token de verificación        : $WA_VERIFY_TOKEN"
echo "y suscríbete al campo 'messages'."
echo
echo "Antes de verificar, asegúrate de que $WEBHOOK_PATH esté excluida de Easy Auth:"
echo "  scripts/whatsapp-setup.sh --exclude-path"
