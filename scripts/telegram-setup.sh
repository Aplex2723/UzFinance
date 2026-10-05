#!/usr/bin/env bash
# Puesta en marcha del bot de Telegram en Azure App Service.
#
# Uso:
#   scripts/telegram-setup.sh                        # pide token (o reutiliza el guardado), autorizados y grupos; guarda App Settings y (si confirmas) registra el webhook
#   scripts/telegram-setup.sh --rotate-secret        # además genera un secreto de webhook NUEVO (por omisión se reutiliza el que ya está en Azure)
#   scripts/telegram-setup.sh --drop-pending         # al (re)registrar o quitar el webhook, descarta los mensajes que Telegram tenga en cola
#   scripts/telegram-setup.sh --exclude-path         # agrega /api/telegram a las rutas excluidas de Easy Auth (muestra el cambio y pide confirmación)
#   scripts/telegram-setup.sh --exclude-path --dry-run   # solo muestra cómo quedaría, sin escribir
#   scripts/telegram-setup.sh --exclude-path --yes       # sin pregunta de confirmación
#   scripts/telegram-setup.sh --webhook-only         # solo (re)registra el webhook con el token y el secreto YA guardados en Azure (conserva los mensajes en cola)
#   scripts/telegram-setup.sh --delete-webhook       # quita el webhook (el bot deja de recibir mensajes)
#
# Variables opcionales (por omisión, los datos de producción de UzFinance):
#   UZ_SUBSCRIPTION  UZ_RG  UZ_APP
#
# Seguridad del script:
#   - El token del bot (BotFather) se pide con `read -s`: no se ve en pantalla, no entra al historial del shell ni pasa por el chat.
#   - Se escriben en un archivo temporal con permisos 600 y se pasan a `az` como `--settings @archivo`, así NO aparecen en la lista
#     de procesos (`ps`). El archivo se borra al terminar (trap), incluso si algo falla o se interrumpe.
#   - Las llamadas a la API de Telegram (getMe, setWebhook, deleteWebhook) las hace `python3` leyendo el token y el secreto del
#     ENTORNO, nunca como argumentos de `curl`: tampoco aparecen en `ps`. Solo se imprime el @usuario del bot o un error fijo.
#   - Nunca se usa `set -x` ni se imprimen secretos; `az ... -o none` evita que `az` repita todas las App Settings en pantalla.
#   - --webhook-only, y el modo normal al reutilizar token o secreto, leen de Azure a una variable del shell (jamás se imprime).
#   - El secreto del webhook se REUTILIZA si ya existe en Azure (así contestar "N" a registrar el webhook no deja al bot en 401);
#     solo se genera uno nuevo si no hay o con --rotate-secret. Los mensajes en cola de Telegram solo se descartan con --drop-pending.
#   - El webhook se registra con max_connections=1: Telegram entrega los mensajes de uno en uno (en orden, sin que una respuesta
#     llegue antes que el pendiente al que contesta).
set -euo pipefail
umask 077

SUB="${UZ_SUBSCRIPTION:-61c871ca-30f7-43ef-a9c7-910fa8c0a5a5}"
RG="${UZ_RG:-rg-uzfinance}"
APP="${UZ_APP:-uzfinance-092d5}"
WEBHOOK_PATH="/api/telegram"
WEBHOOK_URL="https://$APP.azurewebsites.net$WEBHOOK_PATH"
AUTH_API="2022-03-01"

MODE="settings"
DRY_RUN=0
ASSUME_YES=0
ROTATE_SECRET=0
DROP_PENDING=0
for arg in "$@"; do
  case "$arg" in
    --exclude-path) MODE="exclude" ;;
    --webhook-only) MODE="webhook" ;;
    --delete-webhook) MODE="delete" ;;
    --dry-run) DRY_RUN=1 ;;
    --rotate-secret) ROTATE_SECRET=1 ;;
    --drop-pending) DROP_PENDING=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Opción desconocida: $arg (usa --help)" >&2; exit 2 ;;
  esac
done

TMP=""
CUR=""
cleanup() {
  [ -n "$TMP" ] && rm -f "$TMP"
  [ -n "$CUR" ] && rm -f "$CUR"
  unset TG_BOT_TOKEN TG_SECRET TG_ALLOWED TG_CHATS TG_USERNAME TG_URL TG_DROP OLD_TOKEN 2>/dev/null || true
}
trap cleanup EXIT
trap 'echo; echo "Interrumpido: se borró el archivo temporal." >&2; exit 130' INT TERM

command -v az >/dev/null 2>&1 || { echo "Falta Azure CLI (az). Instálalo y corre 'az login'." >&2; exit 1; }
az account show --subscription "$SUB" --only-show-errors -o none 2>/dev/null || { echo "No hay sesión de Azure para la suscripción $SUB. Corre 'az login'." >&2; exit 1; }

# ─── Modo --exclude-path ─────────────────────────────────────────────────────────────────────────────────────────────────
# Telegram llama al webhook SIN sesión de Entra, así que /api/telegram debe estar en `excludedPaths` de Easy Auth (igual que
# /api/ingest, /api/ingest/email y /api/whatsapp). La lista es UNA SOLA propiedad: si se reemplazara en lugar de mezclarse, se
# perderían las rutas que ya estaban excluidas y el Atajo de Wallet, el puente de Gmail, el bot de WhatsApp o la instalación en el
# celular dejarían de funcionar. Por eso: se lee la configuración ACTUAL, se agrega la ruta (si falta), se comprueba que no se
# perdió ninguna y recién entonces se escribe todo el objeto de vuelta con PUT.
# La app sigue protegida: el handler exige el encabezado X-Telegram-Bot-Api-Secret-Token (comparado en tiempo constante).
if [ "$MODE" = "exclude" ]; then
  command -v python3 >/dev/null 2>&1 || { echo "Falta python3 (se usa para mezclar el JSON)." >&2; exit 1; }
  URI="/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.Web/sites/$APP/config/authsettingsV2"
  TMP="$(mktemp)"; chmod 600 "$TMP"
  CUR="$(mktemp)"; chmod 600 "$CUR"

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
  echo "Listo. Verifica (deben seguir todas las rutas que ya había, más $WEBHOOK_PATH):"
  echo "  az rest --method get --uri \"$URI/list?api-version=$AUTH_API\" --subscription $SUB --query properties.globalValidation.excludedPaths -o tsv"
  echo "Prueba sin sesión (debe ser 405 de la app, NO 302/401 de Easy Auth):"
  echo "  curl -s -o /dev/null -w '%{http_code}\\n' \"$WEBHOOK_URL\""
  exit 0
fi

# ─── Utilidades de la API de Telegram (python3 lee token y secreto del ENTORNO) ─────────────────────────────────────────
command -v python3 >/dev/null 2>&1 || { echo "Falta python3 (se usa para llamar a la API sin pasar secretos por argumentos)." >&2; exit 1; }

# Uso: TG_BOT_TOKEN=… [TG_SECRET=… TG_URL=… TG_DROP=1] tg_api getMe|setWebhook|deleteWebhook
# TG_DROP=1 (solo con --drop-pending) descarta los mensajes en cola de Telegram; sin él se conservan.
# Imprime una sola línea: "ok <usuario>" (getMe), "ok" o "error <código> <descripción de Telegram>"/"error red". Nunca el token ni la URL.
read -r -d '' PY_TG <<'PY' || true
import json, os, sys, urllib.request, urllib.error
action = sys.argv[1]
token = os.environ["TG_BOT_TOKEN"]
drop = os.environ.get("TG_DROP") == "1"
body = {}
if action == "setWebhook":
    body = {"url": os.environ["TG_URL"], "secret_token": os.environ["TG_SECRET"], "allowed_updates": ["message"],
            "max_connections": 1}
    if drop:
        body["drop_pending_updates"] = True
elif action == "deleteWebhook":
    if drop:
        body["drop_pending_updates"] = True
req = urllib.request.Request("https://api.telegram.org/bot%s/%s" % (token, action),
                             data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST")
try:
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.load(r)
except urllib.error.HTTPError as e:
    try:
        d = json.load(e)
        print("error %s %s" % (d.get("error_code", e.code), str(d.get("description", ""))[:120]))
    except Exception:
        print("error %s" % e.code)
    sys.exit(1)
except Exception as e:
    print("error red (%s)" % type(e).__name__)
    sys.exit(1)
if not data.get("ok"):
    print("error %s %s" % (data.get("error_code", "?"), str(data.get("description", ""))[:120]))
    sys.exit(1)
if action == "getMe":
    u = (data.get("result") or {}).get("username", "")
    print("ok " + u)
else:
    print("ok")
PY
tg_api() { python3 -c "$PY_TG" "$1"; }

# Lee un App Setting de Azure a stdout sin mostrarlo (se captura en una variable); vacío si no existe.
az_setting() {
  az webapp config appsettings list --subscription "$SUB" --resource-group "$RG" --name "$APP" \
    --query "[?name=='$1'].value | [0]" -o tsv --only-show-errors 2>/dev/null | grep -v '^None$' || true
}

TOKEN_RE='^[0-9]{6,12}:[A-Za-z0-9_-]{30,50}$'
# (macOS trae bash 3.2: su regex no admite intervalos mayores de 255, por eso 255 y no 256 como en la app)
SECRET_RE='^[A-Za-z0-9_-]{32,255}$'

# ─── Modos --webhook-only y --delete-webhook ─────────────────────────────────────────────────────────────────────────────
if [ "$MODE" = "webhook" ] || [ "$MODE" = "delete" ]; then
  TG_BOT_TOKEN="$(az_setting TELEGRAM_BOT_TOKEN)"
  [[ "$TG_BOT_TOKEN" =~ $TOKEN_RE ]] || { echo "TELEGRAM_BOT_TOKEN no está guardado (o es inválido) en $APP. Corre primero: scripts/telegram-setup.sh" >&2; exit 1; }
  export TG_BOT_TOKEN
  if [ "$MODE" = "delete" ]; then
    if [ "$ASSUME_YES" != "1" ]; then
      read -r -p "¿Quitar el webhook del bot? Dejará de recibir mensajes. [s/N] " ans
      case "$ans" in s|S|si|SI|sí|y|Y) ;; *) echo "Cancelado."; exit 0 ;; esac
    fi
    [ "$DROP_PENDING" = "1" ] && export TG_DROP=1
    R="$(tg_api deleteWebhook)" || { echo "Telegram: $R" >&2; exit 1; }
    echo "Webhook eliminado.$([ "$DROP_PENDING" = "1" ] && echo " Se descartaron los mensajes en cola.")"
    exit 0
  fi
  TG_SECRET="$(az_setting TELEGRAM_WEBHOOK_SECRET)"
  [[ "$TG_SECRET" =~ $SECRET_RE ]] || { echo "TELEGRAM_WEBHOOK_SECRET no está guardado (o es inválido) en $APP. Corre primero: scripts/telegram-setup.sh" >&2; exit 1; }
  TG_URL="$WEBHOOK_URL"
  export TG_SECRET TG_URL
  [ "$DROP_PENDING" = "1" ] && export TG_DROP=1
  R="$(tg_api setWebhook)" || { echo "Telegram rechazó el webhook: $R" >&2; exit 1; }
  echo "Webhook registrado en $WEBHOOK_URL (solo 'message', 1 conexión; $([ "$DROP_PENDING" = "1" ] && echo "mensajes en cola descartados" || echo "mensajes en cola conservados"))."
  echo "Prueba: escríbele 'ayuda' al bot. Si no responde, revisa el log: az webapp log tail --name $APP --resource-group $RG --subscription $SUB"
  exit 0
fi

# ─── Modo normal: token, autorizados, App Settings y (opcional) webhook ─────────────────────────────────────────────────
command -v openssl >/dev/null 2>&1 || { echo "Falta openssl (genera el secreto del webhook)." >&2; exit 1; }

echo "Configuración del bot de Telegram para $APP (grupo $RG)."
echo "El token no se muestra al escribirlo. Nada de esto se guarda en el historial."
echo

# Valores que YA están en Azure (nunca se imprimen los secretos; los ids autorizados no son secretos y sirven de valor por omisión).
OLD_TOKEN="$(az_setting TELEGRAM_BOT_TOKEN)"
[[ "$OLD_TOKEN" =~ $TOKEN_RE ]] || OLD_TOKEN=""
OLD_SECRET="$(az_setting TELEGRAM_WEBHOOK_SECRET)"
[[ "$OLD_SECRET" =~ $SECRET_RE ]] || OLD_SECRET=""
OLD_ALLOWED="$(az_setting TELEGRAM_ALLOWED)"
OLD_CHATS="$(az_setting TELEGRAM_ALLOWED_CHATS)"

TG_BOT_TOKEN=""
if [ -n "$OLD_TOKEN" ]; then
  ans="s"
  if [ "$ASSUME_YES" != "1" ]; then read -r -p "Ya hay un token guardado en Azure. ¿Reutilizarlo (sin volver a pegarlo)? [S/n] " ans; fi
  case "$ans" in n|N|no|NO) ;; *) TG_BOT_TOKEN="$OLD_TOKEN" ;; esac
fi
if [ -z "$TG_BOT_TOKEN" ]; then
  read -r -s -p "Token del bot (@BotFather → /newbot o /token): " TG_BOT_TOKEN; echo
  TG_BOT_TOKEN="$(printf '%s' "$TG_BOT_TOKEN" | tr -d '[:space:]')"
fi
[[ "$TG_BOT_TOKEN" =~ $TOKEN_RE ]] || { echo "Token inválido (formato 123456789:AA… sin espacios)." >&2; exit 1; }
export TG_BOT_TOKEN
TOKEN_CHANGED=0
[ "$TG_BOT_TOKEN" = "$OLD_TOKEN" ] || TOKEN_CHANGED=1

echo "Comprobando el token con Telegram (getMe)…"
R="$(tg_api getMe)" || { echo "Telegram no aceptó el token: $R" >&2; exit 1; }
TG_USERNAME="${R#ok }"
[[ "$TG_USERNAME" =~ ^[A-Za-z][A-Za-z0-9_]{2,31}$ ]] || { echo "Respuesta inesperada de Telegram." >&2; exit 1; }
echo "Bot verificado: @$TG_USERNAME"
echo

echo "IDs de Telegram autorizados: 123456789=Uziel,987654321=Ana (de 0 a 5 personas)."
echo "Déjalo VACÍO para el modo descubrimiento: el bot solo responde /id; cada quien se lo pide, y luego repites este script con los IDs."
[ -n "$OLD_ALLOWED" ] && echo "Autorizados actuales: $OLD_ALLOWED  (Enter = conservarlos; '-' = vaciar la lista)"
read -r -p "Autorizados: " TG_ALLOWED
if [ -z "$TG_ALLOWED" ] && [ -n "$OLD_ALLOWED" ]; then TG_ALLOWED="$OLD_ALLOWED"; fi
[ "$TG_ALLOWED" = "-" ] && TG_ALLOWED=""
TG_ALLOWED="$(printf '%s' "$TG_ALLOWED" | sed -e 's/[[:space:]]*,[[:space:]]*/,/g' -e 's/[[:space:]]*=[[:space:]]*/=/g' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/,$//')"
if [ -n "$TG_ALLOWED" ]; then
  IFS=',' read -r -a ENTRIES <<< "$TG_ALLOWED"
  [ "${#ENTRIES[@]}" -le 5 ] || { echo "Debe haber a lo sumo 5 personas." >&2; exit 1; }
  NAME_RE="^[[:alpha:] .'-]{1,30}\$"
  SEEN=","
  for e in "${ENTRIES[@]}"; do
    [[ "$e" == *"="* ]] || { echo "Formato inválido (falta '='): usa id=Nombre." >&2; exit 1; }
    uid="${e%%=*}"; name="${e#*=}"
    [[ "$uid" =~ ^[1-9][0-9]{0,14}$ ]] || { echo "ID inválido (solo dígitos, sin signo; los grupos NO van aquí): $uid" >&2; exit 1; }
    [[ "$name" =~ $NAME_RE ]] || { echo "Nombre inválido (solo letras, espacio, punto, apóstrofo o guion; máx. 30): $name" >&2; exit 1; }
    case "$SEEN" in *",$uid,"*) echo "ID repetido: $uid" >&2; exit 1 ;; esac
    SEEN="$SEEN$uid,"
  done
else
  echo "Modo descubrimiento: no hay autorizados todavía."
fi

echo
echo "Grupos (OPCIONAL): por omisión el bot IGNORA todos los grupos. Para atender uno, pon aquí su ID de chat (negativo, p. ej."
echo "-1001234567890; lo da el comando /id escrito dentro del grupo). Varios separados por coma (máx. 10). En un grupo permitido solo"
echo "responde a comandos con /, a respuestas a sus mensajes y a menciones (@$TG_USERNAME), y solo a las personas autorizadas."
[ -n "$OLD_CHATS" ] && echo "Grupos actuales: $OLD_CHATS  (Enter = conservarlos; '-' = ninguno)"
read -r -p "IDs de grupo (Enter = ninguno/actuales): " TG_CHATS
if [ -z "$TG_CHATS" ] && [ -n "$OLD_CHATS" ]; then TG_CHATS="$OLD_CHATS"; fi
[ "$TG_CHATS" = "-" ] && TG_CHATS=""
TG_CHATS="$(printf '%s' "$TG_CHATS" | sed -e 's/[[:space:]]*,[[:space:]]*/,/g' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/,$//')"
if [ -n "$TG_CHATS" ]; then
  IFS=',' read -r -a CHAT_ENTRIES <<< "$TG_CHATS"
  [ "${#CHAT_ENTRIES[@]}" -le 10 ] || { echo "Debe haber a lo sumo 10 grupos." >&2; exit 1; }
  SEEN_C=","
  for c in "${CHAT_ENTRIES[@]}"; do
    [[ "$c" =~ ^-?[1-9][0-9]{0,14}$ ]] || { echo "ID de grupo inválido (entero distinto de cero, p. ej. -1001234567890): $c" >&2; exit 1; }
    case "$SEEN_C" in *",$c,"*) echo "ID de grupo repetido: $c" >&2; exit 1 ;; esac
    SEEN_C="$SEEN_C$c,"
  done
  [ -n "$TG_ALLOWED" ] || echo "Aviso: sin personas autorizadas el bot no atiende a nadie en el grupo (solo respondería /id)."
fi

# El secreto del webhook se REUTILIZA si ya existe en Azure (el webhook registrado sigue válido aunque no lo registres de nuevo);
# solo se genera uno nuevo si no hay o con --rotate-secret.
SECRET_CHANGED=0
if [ -n "$OLD_SECRET" ] && [ "$ROTATE_SECRET" != "1" ]; then
  TG_SECRET="$OLD_SECRET"
  echo "Se reutiliza el secreto del webhook que ya está en Azure."
else
  TG_SECRET="$(openssl rand -hex 32)"
  SECRET_CHANGED=1
  [ -n "$OLD_SECRET" ] && echo "Se generó un secreto de webhook NUEVO (--rotate-secret): hay que registrar el webhook otra vez."
fi
export TG_SECRET TG_ALLOWED TG_CHATS TG_USERNAME

TMP="$(mktemp)"; chmod 600 "$TMP"
python3 - "$TMP" <<'PY'
import json, os, sys
settings = [
    {"name": "TELEGRAM_BOT_TOKEN", "value": os.environ["TG_BOT_TOKEN"], "slotSetting": False},
    {"name": "TELEGRAM_WEBHOOK_SECRET", "value": os.environ["TG_SECRET"], "slotSetting": False},
    {"name": "TELEGRAM_ALLOWED", "value": os.environ["TG_ALLOWED"], "slotSetting": False},
    {"name": "TELEGRAM_ALLOWED_CHATS", "value": os.environ["TG_CHATS"], "slotSetting": False},
    {"name": "TELEGRAM_BOT_USERNAME", "value": os.environ["TG_USERNAME"], "slotSetting": False},
]
with open(sys.argv[1], "w") as f:
    json.dump(settings, f)
PY

echo
echo "Aplicando App Settings (la app se reinicia unos segundos)…"
az webapp config appsettings set --subscription "$SUB" --resource-group "$RG" --name "$APP" --settings "@$TMP" --only-show-errors -o none
rm -f "$TMP"; TMP=""

# Si el secreto o el token cambiaron, el webhook que Telegram tiene registrado deja de servir (la app respondería 401) hasta que se
# registre otra vez; si no cambiaron, el registro anterior sigue válido. Por eso se ofrece registrarlo aquí mismo.
echo
echo "El webhook solo sirve si YA desplegaste este código (push a main) y /api/telegram está excluida de Easy Auth"
echo "(scripts/telegram-setup.sh --exclude-path)."
ans="n"
if [ "$ASSUME_YES" = "1" ]; then ans="s"; else read -r -p "¿Ya desplegaste y excluiste la ruta? Registrar el webhook ahora [s/N] " ans; fi
case "$ans" in
  s|S|si|SI|sí|y|Y)
    TG_URL="$WEBHOOK_URL"
    export TG_URL
    [ "$DROP_PENDING" = "1" ] && export TG_DROP=1
    if R="$(tg_api setWebhook)"; then
      echo "Webhook registrado en $WEBHOOK_URL (1 conexión; $([ "$DROP_PENDING" = "1" ] && echo "mensajes en cola descartados" || echo "mensajes en cola conservados"))."
    else
      echo "Telegram rechazó el webhook: $R" >&2
      echo "Corrige y repite con: scripts/telegram-setup.sh --webhook-only" >&2
      exit 1
    fi
    ;;
  *)
    echo "Webhook NO registrado. Cuando esté desplegado y excluido: scripts/telegram-setup.sh --webhook-only"
    if [ "$SECRET_CHANGED" = "1" ] || [ "$TOKEN_CHANGED" = "1" ]; then
      echo "(el secreto o el token cambiaron: mientras no lo registres la app responderá 401 a lo que Telegram mande)."
    else
      echo "(el secreto y el token no cambiaron: si ya había un webhook registrado, sigue funcionando)."
    fi
    ;;
esac

echo
echo "Listo. Tu bot: https://t.me/$TG_USERNAME"
if [ -z "$TG_ALLOWED" ]; then
  echo "Siguiente: cada persona abre el bot, le escribe /id y te pasa el número; luego corre de nuevo scripts/telegram-setup.sh con los IDs."
else
  echo "Siguiente: abre el bot y escríbele 'ayuda' (o /ayuda). Un grupo es opcional: ver docs/GUIA.md §11 (TELEGRAM_ALLOWED_CHATS y modo privacidad)."
fi
