# UzFinance: guía rápida (contexto para humanos y para una sesión nueva)

Tracker personal de gastos (Amex, Banamex, Nu). UI en español, MXN, tema oscuro, pensado para el iPhone.
Repo privado: `Aplex2723/UzFinance`. **Un push a `main` despliega a producción** (no hay staging).
Detalle largo en el [README](../README.md); esto es el resumen operativo.

## 1. Cómo funciona

```
Apple Pay ──► Atajo (automatización Wallet) ──POST /api/ingest────────┐
Gmail (avisos de Banamex) ──► Google Apps Script ──POST /api/ingest/email──┤
WhatsApp (bot, sección 10) ──► Meta Cloud API ──POST /api/whatsapp────────────┤
Telegram (bot, sección 11) ──► Bot API ──POST /api/telegram (secret_token)─────┤
                                                                           ▼
                         Next.js 16 (App Service F1) ──► Azure SQL (free offer)
                                   ▲
         Tú (navegador / app instalada) ── Easy Auth (Entra ID, un solo correo permitido)
```

- **Dos fuentes, una fila.** El Atajo llega al instante pero con datos pobres (comercio, monto, tarjeta). El correo de
  Banamex llega después con autorización, fecha exacta y estatus. Misma tarjeta + mismo monto en centavos + ≤ 15 min
  → se **fusionan** en una sola transacción (gana el correo; la fila guarda `sources = shortcut,email`).
- **Amex y Nu** solo tienen Atajo. Un cargo de tarjeta Banamex que solo tiene Atajo y pasa 24 h sin correo se marca
  *Sin confirmación bancaria*.
- **Clasificación de correos:** `expense` (gasto), `card_payment` (pago de tarjeta: **no cuenta** en ninguna estadística) o
  `ignored`. Un correo que no se entiende queda en `unparsed_emails` (sin cuerpo) y sale como *Pendiente de revisión*.
- **Tarjetas de correo:** se identifican por producto + dígitos + titular/adicional. Si no existe, se crea *sin nombrar* y
  el dashboard te pide nombrarla. Las domiciliaciones no crean tarjeta (`account_ref` + tarjeta “Domiciliación”).
- **Ingreso mensual** (Configuración o botón *Editar* en el inicio): alimenta el % gastado, ahorro, proyección y
  presupuesto diario. Un solo valor vigente para todos los meses. Valor inicial 350,000.
- **Insights** (`src/lib/insights.ts`): frases generadas por reglas fijas (sin IA) con las cifras de
  `src/lib/repo/insights.ts`. Dinero siempre en centavos enteros (BIGINT).
- **Categorías (Jev):** orden *tus reglas → comercios que ya categorizaste tú (historial) → Jev*. Jev es el modelo de decisión de
  TypeSafe vía OpenRouter (`src/lib/categorizer/jev.ts`; no es un chat: responde UNA categoría con probabilidad). Se le manda solo el
  comercio y las categorías con su **descripción** (`categories.description`, editable en *Categorías*: cuanto más vocabulario real
  del comercio, más precisa). Probabilidad < 0.6 → queda “sin categoría” y sale en el panel *Comercios por categorizar* del inicio
  (eliges la categoría una vez y vale para todos sus movimientos y los futuros). Lo de Jev lleva etiqueta **IA**; si lo corriges se
  vuelve “manual” y manda sobre Jev. Si Jev falla o tarda (>2.5 s en la ingesta) la transacción se guarda igual sin categoría.
  `CATEGORIZER=jev` + `OPENROUTER_API_KEY` (App Setting; sin la key cae a solo reglas). Medir precisión: `scripts/jev-eval.ts`.
- **Estados de cuenta y MSI:** ver sección 8. **Regla de oro:** cada compra cuenta UNA vez, a su fecha y a precio completo (como el
  Atajo); las mensualidades de MSI no son gastos, solo alimentan los *planes* (`installment_plans`, página `/msi`).
- **Tarjetas ilustradas:** SVG propios (`src/components/CardArt.tsx`); el diseño se deduce del emisor y el nombre
  (`src/lib/card-art.ts`) o se elige en *Editar tarjeta*. No usan imágenes externas.
- **App instalable (PWA):** `src/app/manifest.ts` + íconos en `public/icons/` (se regeneran con
  `npx tsx scripts/make-icons.ts`). **Sin service worker a propósito**: nada de tus finanzas queda en caché del dispositivo.

## 2. Desarrollo local y pruebas

```bash
export PATH="$HOME/.orbstack/bin:$PATH"   # docker (OrbStack) puede no estar en el PATH; `orbctl start` si está apagado
npm run db:up            # SQL Server 2022 en docker
npm run db:reset         # recrea, migra y siembra datos de ejemplo (SOLO base local)
npm run dev              # http://localhost:3000, AUTH_MODE=dev (solo local)
```

| Qué | Comando | Notas |
|---|---|---|
| Tipos y lint | `npm run typecheck && npm run lint` | |
| Unitarias + integración | `npm test` | Integración usa la base local y la limpia; ~340 pruebas |
| E2E (desktop + celular) | `npm run test:e2e` | **Solo local** (se quitaron del CI por lentos). Compila, usa la base propia `uzfinance_e2e` (puerto 3200); ~78 pruebas |
| Humo contra un despliegue | `scripts/smoke.sh <url> [INGEST_TOKEN] [EMAIL_TOKEN]` | 401/200 de los endpoints |
| Probar un correo sin guardar | `POST /api/ingest/email` con `X-Dry-Run: 1` | Devuelve `parsed/ignored/unparsed` + motivo |

Reglas del proyecto: fixtures **inventados** (nunca nombres, dígitos o autorizaciones reales); el cuerpo de un correo es
entrada no confiable (no se loguea ni se guarda completo); no declarar algo funcional sin correr las pruebas.

## 3. Producción (Azure) — datos de referencia

- Grupo `rg-uzfinance`, App Service `uzfinance-092d5`, SQL `uzfinance-sql-092d5`, base `uzfinance`.
  Nunca tocar recursos fuera de ese grupo; el comando de destrucción está en el README y **no se ejecuta**.
- **Migraciones: a mano ANTES de desplegar** (la identidad de la app no tiene DDL ni el pipeline las corre):
  abrir una regla temporal de firewall para tu IP → `npx tsx scripts/azure-sql.ts migrate` (con `DB_SERVER`, `DB_NAME`) →
  **borrar la regla**. Fijar `--subscription` explícito en los comandos `az`.
- **Easy Auth `excludedPaths`** (rutas con su propio token Bearer o públicas y estáticas): `/api/ingest`,
  `/api/ingest/email`, `/api/whatsapp` (webhook de Meta: verify token + firma HMAC), `/api/telegram` (webhook de Telegram: encabezado secreto), `/manifest.webmanifest`, `/icons/*`. Las demás exigen sesión.
- **Secretos:** solo como App Settings (`INGEST_TOKEN`, `EMAIL_INGEST_TOKENS="gmail=<token>"`, `WHATSAPP_*` vía `scripts/whatsapp-setup.sh`, `TELEGRAM_*` vía `scripts/telegram-setup.sh`) y en el Atajo / las propiedades del
  Apps Script. Nunca en el repo, en logs ni en el chat. La base gratuita se pausa a los 60 min sin uso (primer arranque 30–60 s).

## 4. Configurar Gmail (correos de Banamex)

Guía completa: [`integrations/gmail-apps-script/README.md`](../integrations/gmail-apps-script/README.md). Resumen:

1. <https://script.google.com> con la cuenta que recibe los avisos → proyecto nuevo → pega `Code.gs` (y `appsscript.json`).
2. Propiedades del script: `UZ_URL` = URL de la app, `UZ_TOKEN` = token del puente (el valor de `gmail` en `EMAIL_INGEST_TOKENS`).
3. Ejecuta `testConnection()` (autoriza el permiso de Gmail). Debe terminar en `parsed … dryRun:true` sin escribir nada.
4. Ejecuta `backfill()` una vez (6 meses; si dice “incompleto”, vuelve a correrla) y luego `installTrigger()` (cada 5 min).
5. Solo se leen correos de `notificaciones@banamex.com` con asuntos de transacción; cada mensaje se manda por separado con su `messageId`.
6. Si algo sale `unparsed`: en la app aparece *Pendiente de revisión* con el motivo. Para ajustar el parser basta la salida enmascarada de `testConnection()`.

## 5. Configurar Apple Wallet (Atajo)

Requisitos: tarjetas en Wallet, token de ingesta (el de `INGEST_TOKEN`, **distinto** del de Gmail).

1. **Tarjetas en la app:** crea cada tarjeta y pon en **Alias** el nombre *exacto* que Wallet manda (coma para varios).
   Nombres comprobados: `Explora Banamex`, `The Platinum Credit Card American Express`, `Nu Mastercard Gold`.
   Si no coincide, el gasto entra a *Sin asignar* con la nota `Tarjeta sin reconocer: "<texto>"` (no se pierde): copia ese texto como alias.
2. **Atajos → Automatización → + → Wallet** (*Cuando toque una tarjeta o pase de Wallet*; en iOS anteriores se llamaba *Transacción*).
   Marca las tarjetas (Explora, Amex, Nu; las demás no) → **Ejecutar inmediatamente** → sin notificar.
3. **Acciones:** *Fecha actual* → *Formatear fecha* (ISO 8601) → **Obtener contenido de URL**:
   - URL `https://<app>/api/ingest`, método `POST`, cuerpo JSON.
   - Encabezados: `Authorization` = `Bearer <token>` (con espacio), `Content-Type` = `application/json` (exacto, sin punto final).
   - Campos: `merchant` = Comercio, `amount` = Monto, `card` = Tarjeta o pase, `date` = fecha formateada.
4. **Prueba que sí guarda** (atajo manual, valores fijos, **sin** `X-Dry-Run`): ver tabla; respuesta esperada `{"status":"inserted","cardMatched":true}`.

   | merchant | amount | card |
   |---|---|---|
   | `PRUEBA UZ EXPLORA` | `1.01` | `Explora Banamex` |
   | `PRUEBA UZ AMEX` | `1.02` | `The Platinum Credit Card American Express` |
   | `PRUEBA UZ NU` | `1.03` | `Nu Mastercard Gold` |

   Bórralas desde *Transacciones* al terminar. Con `X-Dry-Run: 1` el endpoint solo valida y responde `{"status":"ok","dryRun":true}`.
5. Límites sin confirmar: que el disparador se active con pagos que no son Apple Pay, reembolsos o cargos rechazados.
   Revisa las primeras transacciones reales. Si la base estaba dormida el Atajo puede recibir `503`: reintenta (es idempotente).

## 6. Instalar en el celular

iPhone: Safari → abre la app → Compartir → **Añadir a pantalla de inicio**. Android: Chrome → ⋮ → **Instalar app**.
Abre a pantalla completa con su ícono; el inicio de sesión de Microsoft ocurre dentro de la app instalada.
Requiere HTTPS (producción) y que `/manifest.webmanifest` y `/icons/*` estén en `excludedPaths` (el navegador los pide sin cookies).

## 7. Categorización con Jev (detalle)

- Documentación: <https://openrouter.ai/docs/guides/community/jev-tutorial> · endpoint `POST https://openrouter.ai/api/alpha/decisions`,
  modelo `typesafe/jev-1.13`, pregunta `choice` con `criteria` = {categoría: descripción}. ~$0.00002 por comercio; la salida es gratis.
- Las categorías iniciales salen de la migración `007_seed_categories.sql` (25, con descripción); solo crea las que faltan.
- Precisión medida con ~170 comercios etiquetados a mano: 87 % con descripciones genéricas → 96 % tras ajustarlas al vocabulario de
  los estados (ese 96 % es “dentro de muestra”: lo esperable en comercios nuevos es ~90 %). Los vendedores de Mercado Pago
  (`MERPAGO*NOMBRE`) casi nunca se pueden deducir: van al panel de revisión.
- Para mejorar: edita la descripción de la categoría (agrega nombres como aparecen en el estado) o categoriza el comercio a mano.

## 8. Importar estados de cuenta y MSI

1. **Extraer** (Python, `scripts/statements/README.md`): `run_all.py --downloads ~/Downloads --out <carpeta fuera del repo>` convierte los
   PDF/CSV de Banamex, Nu y Amex en JSON y **verifica los totales impresos** (si algo no cuadra sale con error). Los “Envío de movimientos”
   de Banamex son imagen: se transcriben a mano (ver README). Los JSON llevan datos reales: nunca en el repo.
2. **Mapa de tarjetas** (JSON fuera del repo, formato en `src/lib/import/statements.ts`): a qué tarjeta va cada `card_key`, sección
   (digital) o titular (adicionales de Amex); crea las que falten.
3. **Importar**: `npx tsx scripts/import-statements.ts --dir <extract> --cards <mapa.json> [--dry-run]`. Azure: `--azure` (necesita
   `AZ_SUBSCRIPTION`, `DB_SERVER`, `DB_NAME`, `az login` y una regla de firewall temporal) y `--yes` para escribir; sin `--yes` simula.
   Es idempotente. No duplica lo que ya llegó por Atajo/correo (misma tarjeta + monto + ±2 días, por conteo; pagos de tarjeta: cualquier
   tarjeta ±5 días).
4. **Qué se guarda:** compras, reembolsos, comisiones/intereses/IVA, efectivo, impuestos y transferencias SPEI a terceros (categoría
   *Transferencias*) como gasto; pagos de tarjeta como `card_payment`; **no** se guardan traspasos propios, ingresos ni mensualidades de MSI.
5. **MSI:** `installment_plans` guarda la foto del último estado (cuántas mensualidades van, saldo). Las mensualidades se cargan el día
   siguiente al corte (`src/lib/msi.ts`), de ahí el calendario, “cuándo termina” y las frases de `/msi`. En Banamex la fecha de compra
   no se imprime: se deduce del avance del plan (marcada `started_estimated`). Compras nuevas a MSI entran completas con etiqueta
   “A meses (MSI)”. Importar un estado más nuevo actualiza el mismo plan; uno más viejo no lo retrocede.
6. `--overrides <archivo.json>` aplica tus correcciones a movimientos concretos (categoría, nombre); formato en `overrideSchema`.
7. Reglas confirmadas por el usuario: en el CSV de Nu, “N MSI” es compra a N meses y el monto del renglón es la **mensualidad** del mes en curso
   (total = monto × N). Un cargo diferido a meses futuros sin mensualidad (p. ej. “a pagar en octubre 2027”) no se importa como plan.
   Los depósitos “Inversión Perfiles” son ahorro para el departamento (meta en el inicio), no gasto.

## 9. Documentos PDF, conciliación y alertas (Fase G)

Entrada única: `processDocument` (`src/lib/docs/intake.ts`). La usan `POST /api/documents` (la app, `origin: "app"`) y los bots de chat
(`"whatsapp"` o `"telegram"`, ver `DOC_ORIGIN` en `src/lib/chat-sources.ts`; la migración `010` amplía `documents.origin`). **El PDF no se guarda**: solo su huella SHA-256 (subir dos veces el mismo
archivo no repite nada) y lo extraído (`documents.extracted`). Estados: `processed`, `needs_review`, `rejected`, `failed` (se reprocesa al
volver a subirlo).

- **Comprobante de transferencia** (PDF de la app de Banamex: el texto es imagen). OCR con **Azure AI Vision**
  (`uzfinance-vision-092d5`, nivel gratuito F0 en South Central US —México Central no ofrece el servicio—, mismo grupo y tenant; la app
  se autentica con su identidad administrada, rol *Cognitive Services User*, sin llaves; ≈1 s por página; solo se manda la imagen de la
  página, es un OCR y no un LLM) y **doble lectura** a dos resoluciones. Si Azure falla, o no hay `AZURE_VISION_ENDPOINT` (laptop, pruebas),
  cae al OCR **local** (tesseract.js + `@napi-rs/canvas`, idioma español empaquetado; nada sale del servidor, pero en B1 tarda ~100 s por
  comprobante). Si la lectura pasa de 8 s el bot avisa «lo estoy leyendo». Cuota gratis: 5,000 lecturas/mes (≈4 por comprobante). Con la doble lectura: si monto, rastreo, si monto, rastreo,
  autorización, fecha o cuentas no coinciden, o el monto no trae centavos completos, no se registra solo (`needs_review`). Un PDF con
  texto se lee exacto. Solo transferencias *exitosas*; fechas futuras/muy viejas y montos > $1,000,000 piden confirmación.
  - El CONCEPTO que escribes es el comercio (se categoriza con reglas → historial → Jev; si no, *Transferencias*). Con el concepto genérico
    del banco queda “Transferencia a <alias>”. Hacia una tarjeta propia (Configuración → pagos a tarjetas) es `card_payment`.
  - Dedupe por **clave de rastreo** (`transactions.tracking_key`, único). Si el correo del banco ya la registró (misma autorización, o
    mismo monto a ≤15 min) se completa esa fila, y si el correo llega después solo la confirma. Origen `receipt`.
  - La cuenta de origen (p. ej. MiCuenta ···283) se liga a una tarjeta por: cuenta aprendida (`app_settings.account_card_map`) → misma
    terminación → único débito Banamex. Si es ambigua queda en revisión y puedes marcar “recordar”.
- **Estado de cuenta** (Amex, Nu, Banamex crédito y débito; PDF con texto): extractores **deterministas** en TypeScript
  (`src/lib/pdf/statements`, port de `scripts/statements/*.py`; `scripts/compare-statement-extractors.ts` los compara contra Python con
  tus PDFs reales) con los **checks** de totales. Un PDF sin texto (imagen) o de otro banco se rechaza con la razón; no se usa OCR ni LLM para
  cifras. El mapa estado→tarjeta (`app_settings.statement_card_map`, mismo formato que el importador) se propone solo cuando es
  inequívoco (`src/lib/docs/card-suggest.ts`); si no, el documento espera que lo indiques.
- **Conciliación** (`src/lib/recon`): empareja uno a uno por monto exacto y ±3 días (algoritmo húngaro), y reporta `missing_in_app`,
  `not_in_statement`, `duplicate_suspect`, `amount_mismatch`, `total_mismatch` y `extraction_check_failed`. **Nunca modifica ni borra
  movimientos**: tú decides (importar faltantes con `importMissing`, descartar, marcar resuelto). Los hallazgos son estables entre corridas
  (`fingerprint`): lo que descartaste no reaparece y lo que deja de aplicar se resuelve solo. MSI: la compra completa ya está una vez en la
  app; las mensualidades del estado se ignoran.
- **Alertas** (`src/lib/alerts`): compra fuerte (≥ $5,000 o 3× lo típico del comercio/categoría), comercio nuevo caro, ritmo del mes
  (+25 % vs. el mes pasado o proyección sobre el ingreso), pico del día, duplicado sospechoso, compras Banamex sin confirmar, meta de
  ahorro, diferencias de estado y transferencias registradas. Umbrales y silencios editables (`app_settings.alerts_config`). No alertan
  reembolsos, pagos de tarjeta ni movimientos de más de 3 días (importaciones masivas). `alert_outbox` es la cola de avisos, un canal por fila
  (`UNIQUE (alert_id, channel)`):
  - **Telegram** (gratis, sin plantillas ni ventana de 24 h; apagado por omisión): en **Alertas → Configuración → Telegram** se enciende y
    se elige la gravedad mínima (`telegram: {enabled, minSeverity}` en `alerts_config`). Requiere el bot de Telegram configurado (sección 11)
    y que cada persona de `TELEGRAM_ALLOWED` le haya escrito al bot al menos una vez. `flushTelegramOutbox`
    (`src/lib/alerts/telegram-sender.ts`) manda cada aviso, en texto plano, al **chat privado de cada persona autorizada**. Corre tras crear la
    alerta y en cada `maybeRunPeriodicAlerts` (también reintenta), siempre en segundo plano: un fallo de red nunca rompe ni retrasa la
    ingesta. Reglas del emisor: en **horas de silencio** (`quietHours`, hora CDMX) solo salen las graves y el resto espera; hasta 3
    intentos (espera de 5 y 30 min) y un reintento solo escribe a quien aún no lo recibió (`sent_to` se guarda **después de cada persona**,
    no al final: si el proceso muere tras enviarle a la primera, el reintento no se lo repite); nada de más de 24 h, ni de alertas ya leídas o
    descartadas; `last_error` es un texto corto sin token ni URL. Dos corridas simultáneas no duplican (reserva atómica por fila).
    - **Qué pasa con lo pendiente:** el aviso solo pasa a `skipped` si el **canal está apagado** en la configuración de alertas (o por caducidad
      de 24 h, leído o descartado). Con Telegram **mal configurado** (p. ej. `TELEGRAM_ALLOWED` mal escrito: el log nombra la variable, nunca
      su valor) o **sin destinatarios** el aviso se queda `pending`: sale solo cuando se corrige la configuración y, si no, caduca a las 24 h.
    - **No hay temporizador ni tarea programada:** los avisos retenidos por las horas de silencio (y los reintentos) salen **cuando alguien abre
      la app o llega una ingesta** después de que termine el silencio, no a la hora exacta en que termina. Si nadie abre la app ni entra una
      compra, esperan. No se agregó un scheduler a propósito (el plan B1 no tiene uno y no hace falta para este volumen).
    - **Costo por render:** la comprobación corre en el layout, así que es una sola consulta (`outboxPulse`) cuando no hay nada abierto o
      vencido; durante el silencio con avisos retenidos son dos (la anterior y la configuración de alertas).
  - **WhatsApp**: apagado (requiere plantillas aprobadas por Meta); la cola `whatsapp` se llena si se enciende, pero nada la envía todavía (solo
    Telegram tiene emisor).
- **Etiquetas de fuente en la app:** `sourcesLabel` / `SOURCE_UI_LABELS` (`src/lib/chat-sources.ts`) traducen `sources` (“Telegram + Atajo +
  Correo”, “WhatsApp (fecha indicada)”) en Transacciones, Actividad y los hallazgos del estado de cuenta.
- **Despliegue:** las migraciones `009` y `010` van **a mano antes del push** (regla de firewall temporal; ver el runbook del README). `next.config.ts`
  incluye en la traza el idioma del OCR, el worker y el WASM; el proxy admite cuerpos de hasta 14 MB. En el plan B1 el OCR corre de uno en
  uno (≈3 s por comprobante) y libera su memoria a los 60 s de inactividad.

## 10. Bot de WhatsApp (Meta Cloud API)

> **Qué bot usar.** Hoy se usará **Telegram** (sección 11): es gratis, sin plantillas ni ventana de 24 h y funciona en grupos. El bot de
> WhatsApp está **construido y apagado** (sin `WHATSAPP_*` el webhook responde 503 y no procesa nada) hasta que se configure con esta
> sección. Ambos comparten la misma lógica de conversación y las mismas tablas.

Registra gastos y consulta tu información escribiendo (o mandando un PDF) a un número de WhatsApp. Solo responde a los
números de `WHATSAPP_ALLOWED`; cualquier otro se ignora **sin respuesta**.

**Cómo funciona.** Meta llama a `POST /api/whatsapp` cada vez que alguien escribe al número del bot:

```
Tu WhatsApp ──► Meta (Cloud API) ──POST /api/whatsapp (firma HMAC)──► App Service ──► handler (texto / PDF / deshacer…)
                      ▲                                                     │
                      └───────────────── Graph API: respuesta ◄─────────────┘
```

- **Fuera de Easy Auth** (`excludedPaths`), como `/api/ingest`: Meta no tiene sesión de Entra. La autenticación es de Meta:
  `GET` (alta del webhook) exige el **verify token**; `POST` exige la firma `X-Hub-Signature-256` = HMAC-SHA256 del cuerpo crudo con el
  **App Secret**, verificada en tiempo constante *antes* de leer el JSON (sin cabecera de firma ni se lee el cuerpo). Sin firma válida →
  401 y nada se procesa. Sin configuración válida el webhook **falla cerrado** (503).
- **Límites por IP solo para quien NO se autentica:** 10 firmas malas (o verify tokens malos en el `GET`) desde una IP → bloqueo de 10 min
  (429). Una petición con firma válida, o un `GET` con el verify token correcto, se procesa siempre: la IP de Meta no se puede bloquear
  mandando peticiones falsas. La IP se toma de la **última** entrada de `X-Forwarded-For` (la que agrega Azure), no de la primera (la
  controla el cliente).
- **Se procesa ANTES de responder 200** (hasta 20 s): si la app se reinicia a media ejecución, Meta no recibe su 200 y **reintenta**. El
  reclamo del mensaje (`claimMessageState`) distingue cuatro casos: nuevo o `received` de más de 2 min (el proceso murió) → se procesa;
  `done/failed/ignored` → duplicado, 200 sin hacer nada; `received` **reciente** (alguien lo tiene, o el proceso murió hace segundos y Meta
  reintenta enseguida) → **503 con `Retry-After: 5`** para que Meta vuelva a intentar cuando ya sea reclamable, en vez de perder el mensaje. Si
  el primer intento sigue vivo y ya contestó 200, no habrá más reintentos y el 503 no hace daño. Si tarda más de 20 s (un OCR lento) se
  responde 200 y termina en `after()`: **si el proceso muere después de ese 200 no hay reproceso automático** (Meta ya dio el mensaje por
  entregado); reenvía el mensaje. Cada mensaje (`wamid`) se procesa **una vez** aunque Meta reintente (`whatsapp_messages`, migración `010`, **a mano
  antes del push**). Los mensajes de un mismo POST van en serie y en orden (si alguno está "en vuelo", el POST completo responde 503: los
  demás ya procesados quedan `done` y no se repiten en el reintento).
- **Cuerpos sin `Content-Length`:** `proxy.ts` solo puede rechazar por la cabecera; un cuerpo con transferencia en trozos lo lee el handler con
  tope de bytes (413), pero Next ya pudo haberlo copiado en memoria antes (limitación preexistente; no afecta a Meta, que siempre manda
  `Content-Length`).
- **Remitente:** se compara el **número completo** (11 a 15 dígitos, con lada de país). Lo único que se equipara es el caso de México: Meta
  manda `521` + 10 dígitos y la lista puede llevar `52` + 10 dígitos. Ya **no** se compara por los últimos 10 dígitos (`+52 55 1234 5678`
  y `+1 551 234 5678` terminan igual pero son números distintos).
- **Nunca se loguean** cuerpos, textos, nombres, números completos ni tokens: solo conteos, el final del id del mensaje y estados;
  los números salen enmascarados (`***1234`).
- Código: `src/app/api/whatsapp/route.ts` (solo exporta GET/POST) → `src/lib/whatsapp/webhook.ts` (fábrica `createWebhookHandlers`),
  `signature.ts`, `payload.ts`, `allowlist.ts`, `config.ts`, `graph.ts` (cliente de la Graph API; `downloadMedia` solo acepta URLs `https`
  de hosts de Meta y corta la descarga al pasarse del tope).

### Pasos en Meta (una sola vez)

1. <https://developers.facebook.com> → *Mis apps* → **Crear app** → tipo **Empresa (Business)**. Pide (o crea) un portafolio de Meta Business.
2. En la app: **Agregar producto → WhatsApp**. En *Configuración de la API* Meta te da un **número de prueba** (gratis) y su
   **Phone number ID** (cópialo; no es el teléfono). Agrega como destinatarios **hasta 5 números** (los de tu pareja y el tuyo) y verifica
   cada uno con el código que les llega por WhatsApp.
3. **Token permanente** (el temporal de la página dura 24 h): <https://business.facebook.com/settings> → *Usuarios → Usuarios del sistema* →
   **Agregar** (rol Administrador) → *Asignar activos*: la app y la cuenta de WhatsApp Business (control total) → **Generar token**: elige la app,
   caducidad *Nunca* y los permisos `whatsapp_business_messaging` y `whatsapp_business_management`. Copia el token (solo se muestra una vez).
4. **App Secret**: en la app → *Configuración → Básica* → *Clave secreta de la app* → Mostrar.
5. Corre el script (siguiente sección) con esos datos y luego `--exclude-path`.
6. En *WhatsApp → Configuración* → **Webhook → Editar**: pega la **URL** (`https://uzfinance-092d5.azurewebsites.net/api/whatsapp`) y el
   **verify token** que imprimió el script → *Verificar y guardar*. Después, en *Campos del webhook*, **suscríbete a `messages`**.
7. Desde un número autorizado escribe `ayuda` al número de prueba. (El primer mensaje puede requerir que lo abras desde *Configuración de la API*
   enviando la plantilla `hello_world`, o simplemente escribirle al número que aparece en *From*.)

### Correr el script

Los secretos **no** se pasan por el chat ni quedan en el historial: el script los pide en terminal (`read -s`), los escribe en un
archivo temporal `chmod 600` que borra al terminar y los aplica con `az webapp config appsettings set --settings @archivo`.

```bash
az login                                   # si no hay sesión
scripts/whatsapp-setup.sh                  # token de acceso, App Secret, Phone number ID, números autorizados, con lada de país (525512345678=Uziel,525587654321=Ana)
scripts/whatsapp-setup.sh --exclude-path --dry-run   # mira cómo quedaría la lista de rutas excluidas
scripts/whatsapp-setup.sh --exclude-path             # agrega /api/whatsapp a excludedPaths de Easy Auth (pide confirmación)
```

- Genera `WHATSAPP_VERIFY_TOKEN` con `openssl rand` y al final imprime **solo** la URL del webhook y ese token.
- `--exclude-path` **mezcla** con la lista actual (`/api/ingest`, `/api/ingest/email`, `/manifest.webmanifest`, `/icons/*` y, si ya la agregaste, `/api/telegram`): nunca la
  reemplaza, porque perder una de esas rutas rompe el Atajo, el puente de Gmail o la instalación en el celular. Verifica con:
  `az rest --method get --uri "/subscriptions/<sub>/resourceGroups/rg-uzfinance/providers/Microsoft.Web/sites/uzfinance-092d5/config/authsettingsV2/list?api-version=2022-03-01" --query properties.globalValidation.excludedPaths -o tsv`
  (5 rutas con WhatsApp, 6 si también está `/api/telegram`) y `curl -s -o /dev/null -w '%{http_code}\n' https://uzfinance-092d5.azurewebsites.net/api/whatsapp`
  (sin parámetros) → **403** (de la app; un 302/401 sería Easy Auth).
- Cambiar App Settings reinicia la app unos segundos. Variables (ver `.env.example`): `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`,
  `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ALLOWED`, `WHATSAPP_GRAPH_VERSION` (opcional, `v25.0` por omisión, igual que el script), `APP_URL` (opcional;
  en Azure se deduce de `WEBSITE_HOSTNAME`).

### Comandos del bot

| Mensaje | Qué hace |
|---|---|
| `ayuda` | Lista los comandos |
| `tarjetas` | Tus tarjetas y su uso |
| `resumen` | Lo gastado hoy y en el mes, y qué % del ingreso mensual es (no da proyección) |
| `hoy` | Lo gastado hoy |
| `deshacer` | Borra **solo el ÚLTIMO** registro tuyo de los últimos 30 min (otro `deshacer` no retrocede al anterior). Si el correo o el Atajo ya lo confirmaron, no lo toca y te lo dice |
| `cancelar` | Descarta el gasto a medias que está esperando respuesta |
| `350 starbucks` | Registra un gasto; si falta la tarjeta o el comercio, te pregunta y respondes en un mensaje |
| `1,250.50 gasolina amex` | Gasto con tarjeta indicada (monto con coma/punto como en MXN) |
| PDF de un comprobante / estado de cuenta | Lo sube a *Documentos* y lo concilia (como en la app) |

**Las fotos no se leen**: solo PDF (el bot responde "Por ahora leo texto y PDF"; mándalo como PDF o escribe el gasto). Los demás tipos que no
entiende (reacciones, ubicación, stickers, notas de voz…) reciben la misma respuesta corta de ayuda.

### Límites y costos

- **Ventana de 24 h:** las respuestas del bot dentro de las 24 h posteriores a tu último mensaje son gratis (conversación de servicio). Fuera de
  esa ventana WhatsApp solo permite **plantillas** aprobadas (con costo): el bot **no** inicia conversaciones por su cuenta (las alertas por
  WhatsApp siguen apagadas). Si no le escribes en un día, simplemente escríbele y responde.
- El **número de prueba** solo habla con los destinatarios que verificaste (máx. 5) y sirve para uso personal; no hay grupos de WhatsApp.
  Para un número propio hay que registrar uno en WhatsApp Business (no puede estar ya en la app de WhatsApp).
- **Costo:** el número de prueba y las conversaciones iniciadas por ti dentro de la ventana de 24 h no se cobran; revisa la tarifa vigente de
  Meta antes de usar plantillas. El resto (App Service, Azure SQL) no cambia.
- El cuerpo máximo aceptado es 256 KB (el proxy responde 413 por `Content-Length` antes de copiarlo) y las respuestas se truncan a 4096
  caracteres; los archivos descargados tienen tope de tamaño.
- Si la base gratuita está en pausa (primer mensaje tras 60 min sin uso) la respuesta puede tardar 30–60 s; si no se pudo registrar el mensaje el
  bot pide reenviarlo.

### Solución de problemas

| Síntoma | Causa probable |
|---|---|
| Meta: "No se pudo validar la URL o el token" | `/api/whatsapp` no está en `excludedPaths` (el `curl` da 302/401: corre `--exclude-path`), el verify token no coincide (403), faltan App Settings (503: en el *log stream* aparece `sin configuración válida (VARIABLE)` con los nombres, nunca los valores) o la app estaba dormida: reintenta. |
| El webhook responde **401** | Firma inválida: el **App Secret** guardado no es el de *esa* app (¿lo rotaste?) o algo modifica el cuerpo. 10 fallos desde una IP → 429 durante 10 min (no afecta a Meta con la firma buena). |
| El webhook responde **403** | `hub.verify_token` distinto del de `WHATSAPP_VERIFY_TOKEN` (solo ocurre al dar de alta el webhook). |
| Escribo y **no responde** | Tu número no está en `WHATSAPP_ALLOWED` (se ignora a propósito; el log dice `remitente no autorizado ***1234`); no suscribiste el campo `messages`; el token de acceso caducó o le faltan permisos (log: `envío falló: status=401/403 code=190…`); estás fuera de la ventana de 24 h o el destinatario no está verificado; el `Phone number ID` es de otro número. |
| Responde "Ocurrió un error…" | El handler falló: el mensaje queda `failed` en `whatsapp_messages`; mira el log (`error procesando …`) y reintenta con otro texto. |
| Se procesa dos veces | No debería: la llave es el `wamid`. Revisa que la migración `010` esté aplicada. |

Ver logs: `az webapp log tail --name uzfinance-092d5 --resource-group rg-uzfinance --subscription 61c871ca-30f7-43ef-a9c7-910fa8c0a5a5`.

**Rotar secretos:** (1) token de acceso: genera uno nuevo en el usuario del sistema (revoca el viejo) y vuelve a correr `scripts/whatsapp-setup.sh`
(vuelve a pedir todo y genera un verify token nuevo; el verify token solo importa al dar de alta el webhook, así que no hace falta
reconfigurar Meta salvo que quieras re-verificarlo); (2) App Secret: *Restablecer* en *Configuración → Básica* y volver a correr el script;
(3) lista de autorizados: correr el script de nuevo con la lista nueva.

## 11. Bot de Telegram

Misma lógica que el bot de WhatsApp (gastos por texto, PDF, deshacer, resumen…), pero por Telegram: **gratis, sin plantillas ni ventana
de 24 h, funciona en grupos (opcional)** y puede recibir archivos de hasta 20 MB (el bot descarga PDF de hasta 12 MB). Solo responde a los IDs de
`TELEGRAM_ALLOWED`; cualquier otro se ignora **sin respuesta** (la única excepción es el comando `/id`, que devuelve el ID de quien lo pide
para poder configurarlo). Además manda los avisos de alertas a esas mismas personas (sección 9).

**Compras a meses sin intereses (MSI).** Se escriben igual que un gasto, con los meses: `3820 amex beatriz a 3 msi`, `$12,000 amex iphone a 12
meses sin intereses`, `5000 amex tele 12msi`, `800 amex cine en 3 mensualidades` (un «N meses» a secas solo cuenta si lo introduce «a/en/por»;
«hace 2 meses» no). El monto es el **total** de la compra (si falta, el bot lo pregunta «en total»). Entra como cualquier compra —una vez,
a precio completo— y además crea su plan en `/msi` (mensualidad = total ÷ meses; de 2 a 48 meses; solo tarjetas de crédito: en débito el bot
no registra nada). El primer cobro se calcula con el **corte** de esa tarjeta, deducido de los estados ya cargados (`recon_runs` y planes de
estado de cuenta); sin ninguno, el bot lo dice y las fechas son aproximadas hasta cargar un estado. El plan queda con `source='manual'`:
*deshacer* lo borra junto con el gasto, y el primer estado de cuenta que traiga la misma compra (misma tarjeta, monto, meses y fecha ±45 días,
aunque el comercio se llame distinto) lo **adopta** en vez de duplicarlo, conservando el nombre que le pusiste (`upsertPlan`).

**Cómo funciona.** Telegram llama a `POST /api/telegram` por cada mensaje que le escriben al bot:

```
Tu Telegram ──► Telegram (Bot API) ──POST /api/telegram (secret_token)──► App Service ──► handler (texto / PDF / deshacer…)
                      ▲                                                        │
                      └──────────── Bot API: sendMessage (respuesta) ◄──────────┘
```

- **Fuera de Easy Auth** (`excludedPaths`), como `/api/whatsapp`: Telegram no tiene sesión de Entra. Solo `POST` (un `GET` responde 405).
  La autenticación es el encabezado `X-Telegram-Bot-Api-Secret-Token`, que debe ser igual a `TELEGRAM_WEBHOOK_SECRET` (el `secret_token`
  del `setWebhook`), comparado en tiempo constante **antes** de leer el cuerpo. Sin él → 401 y nada se procesa.
  `proxy.ts` rechaza con 413 los cuerpos de más de 256 KB por `Content-Length` antes de que Next los copie en memoria.
- **Límites por IP solo para quien NO se autentica:** 10 secretos malos desde una IP → bloqueo 10 min (429). Una petición con el secreto
  correcto se procesa siempre (la IP de Telegram no se puede bloquear mandando peticiones falsas). La IP se toma de la **última** entrada
  de `X-Forwarded-For` (la que agrega Azure), no de la primera (la controla el cliente).
- **Se procesa ANTES de responder 200** (hasta 20 s): si la app se reinicia a media ejecución, Telegram no recibe su 200 y **reintenta**
  (a los pocos segundos). Qué pasa al reiniciar, según la fila del update (`claimMessageState`): nueva o `received` de más de 2 min → se
  procesa; `done/failed/ignored` → duplicado, 200 sin hacer nada; `received` **reciente** (el proceso murió hace segundos) → **503 con
  `Retry-After: 5`**: Telegram reintenta con espera creciente y, en cuanto pasan los 2 min, el update ya es reclamable y se procesa (antes
  esto perdía el mensaje). Si el primer intento sigue vivo y ya contestó 200, no habrá más reintentos y el 503 no hace daño. Si tarda más de
  20 s (un OCR lento) se responde 200 y termina en `after()`: **si el proceso muere después de ese 200 no hay reproceso automático**
  (Telegram ya dio el update por entregado); reenvía el mensaje. Cada update (`tg:<update_id>`) se procesa **una vez**
  (`whatsapp_messages`, migración `010`: las tablas sirven a ambos canales; la clave de conversación es `tg<idDeUsuario>`).
- **Un update a la vez** (`max_connections: 1` en el `setWebhook`): Telegram entrega los mensajes de uno en uno, así que los de una misma
  persona se procesan en orden y la respuesta a una pregunta del bot no llega antes que el gasto pendiente al que contesta.
- **Cuerpos sin `Content-Length`:** `proxy.ts` rechaza por `Content-Length` antes de que Next copie el cuerpo; uno sin esa cabecera lo lee el
  handler con tope de bytes (413), pero Next ya pudo haberlo copiado (limitación preexistente; Telegram siempre manda `Content-Length`).
- Solo cuenta `message` en chats `private`, `group` y `supergroup`; se ignoran mensajes editados, canales, botones, cambios de membresía y
  mensajes de otros bots.
- **Grupos: opcionales y cerrados por omisión.** Los chats privados funcionan siempre. Un grupo/supergrupo se **ignora por completo** (sin
  respuesta, sin filas) salvo que su ID esté en `TELEGRAM_ALLOWED_CHATS` (ids de chat separados por coma, negativos como `-1001234567890`, máx. 10;
  vacía por omisión; una lista mal escrita apaga todo el bot, igual que `TELEGRAM_ALLOWED`). La lista blanca de personas no basta: es por
  persona, y en un grupo `resumen`/`hoy`/`tarjetas` se publican a **todos sus miembros**, por eso el grupo debe ser uno donde confíes en todos.
  Incluso en un grupo permitido el bot oye todo (privacidad apagada) pero solo procesa lo que se le **dirige**: un comando con `/`
  (`/resumen`), un mensaje que **responde a un mensaje del bot** (así contestas sus preguntas) o que lo **menciona** (`@tu_usuario_bot 350 starbucks
  amex`; requiere `TELEGRAM_BOT_USERNAME`; la mención se quita del texto). La plática normal (`nos vemos a las 8`) se ignora sin responder.
  Aun dirigido, el bot **no contesta "no encontré un monto" ni "no tengo nada pendiente"** en un grupo (en privado sí). Un PDF en el grupo se
  atiende si responde a un mensaje del bot o lo menciona en el pie. Solo las personas de `TELEGRAM_ALLOWED` reciben respuesta; los demás
  miembros se ignoran. `/id` funciona en cualquier chat (así se descubre el ID del grupo).
- **Nunca se loguean** textos, nombres, tokens, secretos ni URLs de archivo: solo conteos, ids enmascarados (`***1234`) y estados. El texto
  de salida es plano (sin `parse_mode`): un comercio con caracteres raros no rompe el formato, y las *negritas* con asteriscos de los
  textos compartidos con WhatsApp se quitan antes de enviar.
- Código: `src/app/api/telegram/route.ts` → `src/lib/telegram/webhook.ts` (fábrica `createTelegramWebhook`), `secret.ts`, `ip.ts`,
  `payload.ts`, `config.ts`, `api.ts` (cliente de la Bot API: `downloadMedia` solo habla con `api.telegram.org`, valida la ruta del archivo
  y corta la descarga al pasarse del tope; sus errores nunca llevan el token).

### Pasos en Telegram y en Azure (una sola vez)

1. **Crea el bot** con [@BotFather](https://t.me/BotFather): `/newbot` → un nombre (p. ej. *UzFinance*) → un usuario que termine en `bot`
   (p. ej. `uzfinance_uz_bot`). BotFather te da el **token** (`123456789:AA…`): **no lo pegues en chats**, solo en la terminal del script.
2. **Solo si lo usarás en un grupo (opcional; por privado no hace falta):** agrega el bot al grupo. Con la privacidad **activada** (la de
   fábrica) Telegram solo le entrega comandos `/…` y respuestas a sus mensajes; para que también le lleguen las **menciones**
   (`@tu_usuario_bot 350 starbucks`) desactívala: BotFather `/setprivacy` → elige el bot → **Disable** (y quita y vuelve a agregar el bot al
   grupo), o hazlo administrador. Es seguro: aunque el bot oiga todo el grupo, solo procesa lo que se le dirige y solo en chats de
   `TELEGRAM_ALLOWED_CHATS` (ver arriba). Para que atienda ese grupo hay que ponerlo en esa variable (paso 6).
3. **Descubrimiento:** corre `scripts/telegram-setup.sh`, pega el token y **deja vacíos los autorizados**. Con la lista vacía el bot solo
   responde `/id`.
4. Cada quien abre el bot y le escribe `/id`: responde `Tu ID de Telegram es 123456789.` (en un grupo también el ID del chat). Junta los IDs.
5. Vuelve a correr `scripts/telegram-setup.sh` con los IDs (`123456789=Uziel,987654321=Ana`, de 0 a 5; los IDs de grupo **no** van aquí). El
   script te ofrece reutilizar el token ya guardado en Azure (no hace falta volver a pegarlo).
6. **Grupo (opcional):** escribe `/id` **dentro del grupo**: el bot responde `Tu ID de Telegram es … El ID de este chat es -100…` (funciona
   aunque el grupo aún no esté permitido). Ese número negativo es el ID del grupo: pégalo en la pregunta "IDs de grupo" del script (queda
   en `TELEGRAM_ALLOWED_CHATS`). Sin esto el bot ignora el grupo por completo.
7. Excluye la ruta de Easy Auth: `scripts/telegram-setup.sh --exclude-path` (muestra el cambio y pide confirmación).
8. **Despliega** este código (push a `main`) y registra el webhook: el mismo script lo ofrece al final ("¿Ya desplegaste y excluiste la
   ruta?") o corre `scripts/telegram-setup.sh --webhook-only` (usa el token y el secreto ya guardados en Azure, sin imprimirlos).
9. Escríbele `ayuda` (o `/ayuda`) al bot.

```bash
az login                                          # si no hay sesión
scripts/telegram-setup.sh                         # token (BotFather o el guardado), IDs autorizados y grupos; guarda App Settings; ofrece registrar el webhook
scripts/telegram-setup.sh --rotate-secret         # igual, pero con un secreto de webhook nuevo (hay que registrar el webhook de nuevo)
scripts/telegram-setup.sh --exclude-path --dry-run   # mira cómo quedaría la lista de rutas excluidas
scripts/telegram-setup.sh --exclude-path          # agrega /api/telegram a excludedPaths de Easy Auth (mezcla con la lista actual)
scripts/telegram-setup.sh --webhook-only          # (re)registra el webhook: URL, secret_token, solo "message", 1 conexión (conserva los mensajes en cola)
scripts/telegram-setup.sh --webhook-only --drop-pending   # igual, pero descarta los mensajes que Telegram tenga en cola
scripts/telegram-setup.sh --delete-webhook        # apaga el bot (quita el webhook)
```

- El **secreto del webhook se reutiliza**: el script lee `TELEGRAM_WEBHOOK_SECRET` de Azure (sin imprimirlo) y solo genera uno nuevo
  (`openssl rand -hex 32`) si no existe o con `--rotate-secret`. Así contestar "N" a "¿registrar el webhook?" no deja al bot en 401: el webhook que
  ya estaba registrado sigue valiendo. Con secreto o token nuevos sí hay que registrarlo otra vez (el script lo avisa) o la app contestará 401.
- Los mensajes que Telegram tenga en cola **no se descartan** al registrar el webhook (antes siempre se descartaban): solo con `--drop-pending`.
- El token se pide con `read -s`, va a un archivo temporal 600 que se borra al terminar y se pasa a `az` como `--settings @archivo`; las llamadas a
  Telegram las hace `python3` leyendo el token del entorno: **no aparece en `ps`**. Variables: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`,
  `TELEGRAM_ALLOWED`, `TELEGRAM_ALLOWED_CHATS` (opcional: ids de grupo atendidos; vacía = ningún grupo), `TELEGRAM_BOT_USERNAME` (opcional pero
  recomendada con grupos: detecta menciones y respuestas al bot e ignora comandos dirigidos a otro bot, `/resumen@OtroBot`).
- `--exclude-path` **mezcla** con la lista actual (nunca la reemplaza: perder `/api/ingest`, `/api/ingest/email`, `/api/whatsapp`,
  `/manifest.webmanifest` o `/icons/*` rompe el Atajo, el puente de Gmail, WhatsApp o la instalación en el celular). Verifica con el
  `az rest … excludedPaths` de la sección 10 y `curl -s -o /dev/null -w '%{http_code}\n' https://uzfinance-092d5.azurewebsites.net/api/telegram`
  → **405** (de la app; un 302/401 sería Easy Auth).

### Comandos del bot

| Mensaje | Qué hace |
|---|---|
| `/id` | Responde tu ID de Telegram (y el del chat en un grupo, aunque no esté permitido). Única respuesta a quien no está autorizado |
| `/ayuda`, `/help`, `/start` | Lista los comandos |
| `/tarjetas` | Tus tarjetas y su uso |
| `/resumen` | Lo gastado hoy y en el mes, y qué % del ingreso mensual es (no da proyección) |
| `/hoy` | Lo gastado hoy |
| `/deshacer` | Borra **solo el ÚLTIMO** registro tuyo de los últimos 30 min; si el correo o el Atajo ya lo confirmaron, no lo toca |
| `/cancelar` | Descarta el gasto a medias que está esperando respuesta |
| `350 starbucks amex` | Registra un gasto; si falta la tarjeta o el comercio, te pregunta y respondes en un mensaje |
| `1,250.50 gasolina` | Gasto con monto con coma/punto como en MXN |
| PDF (comprobante o estado de cuenta) | Lo sube a *Documentos* y lo concilia (como en la app) |

Las palabras sueltas (`ayuda`, `hoy`, `resumen`…) funcionan igual que los comandos con `/`; los argumentos tras el comando se respetan y un
comando desconocido se trata como texto normal. Fotos, notas de voz, stickers, ubicaciones… reciben una respuesta corta de ayuda.

### Límites

- Cuerpo máximo aceptado 256 KB; respuestas truncadas a 4096 caracteres (límite de Telegram); PDF de hasta 12 MB (Telegram solo entrega
  archivos de hasta 20 MB al bot).
- En un grupo permitido cada persona tiene su propia conversación pendiente y su propio "deshacer"; las respuestas salen al grupo.
- Si la base gratuita está en pausa (primer mensaje tras 60 min sin uso) la respuesta puede tardar 30–60 s; si no se pudo registrar el mensaje el
  bot pide reenviarlo.
- El bot solo inicia conversación para los **avisos de alertas** (sección 9: apagados por omisión; salen al chat privado de cada persona autorizada,
  que debe haberle escrito al bot al menos una vez; nunca a un grupo).

### Solución de problemas

| Síntoma | Causa probable |
|---|---|
| El bot no responde nunca | El webhook no está registrado: revísalo con `curl -s "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"` (hazlo en tu terminal, **sin pegar el token en chats**): `url` vacía → `--webhook-only`; `last_error_message` dice qué falló (401/403/302/503). `allowed_updates` debe ser `["message"]`. |
| `getWebhookInfo` muestra **401** o la app registra `401` | El secreto del webhook ≠ `TELEGRAM_WEBHOOK_SECRET` (corriste el script sin registrar de nuevo): `--webhook-only`. 10 fallos desde una IP → 429 durante 10 min (no afecta a Telegram con el secreto bueno). |
| `getWebhookInfo` muestra **302** o 401 con HTML de Microsoft | `/api/telegram` no está en `excludedPaths`: `--exclude-path`. |
| **503** sin `Retry-After: 5` (o `Retry-After: 300`) | Faltan App Settings o alguno es inválido (el log dice `sin configuración válida (VARIABLE)`, solo el nombre). `TELEGRAM_ALLOWED` o `TELEGRAM_ALLOWED_CHATS` mal formadas también apagan el bot a propósito. |
| **503** con `Retry-After: 5` | Normal tras un reinicio: el update ya estaba reclamado hace menos de 2 min; Telegram reintenta solo y se procesa (ver arriba). |
| Responde solo a `/id` | Modo descubrimiento: `TELEGRAM_ALLOWED` está vacía. Corre el script con los IDs. |
| Escribo en privado y no responde, pero `/id` sí | Tu ID no está en `TELEGRAM_ALLOWED` (se ignora a propósito; el log dice `remitente no autorizado ***1234`). |
| En un grupo no responde nunca (ni a `/hoy`) | El grupo no está en `TELEGRAM_ALLOWED_CHATS`: escribe `/id` en el grupo, copia el ID del chat (negativo) y corre el script. También confirma que quien escribe esté en `TELEGRAM_ALLOWED`. |
| En un grupo permitido no responde a "350 starbucks" suelto | A propósito: solo atiende comandos `/…`, respuestas a un mensaje del bot y menciones (`@tu_usuario_bot 350 starbucks`; define `TELEGRAM_BOT_USERNAME`). |
| En un grupo con varios bots no responde a `/hoy` | Escribe `/hoy@tu_usuario_bot`; con `TELEGRAM_BOT_USERNAME` definido, los comandos dirigidos a otro bot se ignoran. |
| Responde "Ocurrió un error…" | El handler falló: el mensaje queda `failed` en `whatsapp_messages`; mira el log (`error procesando …`). |
| Un PDF "pesa demasiado" | Más de 12 MB (el bot no descarga más). Súbelo desde la app. |

Ver logs: `az webapp log tail --name uzfinance-092d5 --resource-group rg-uzfinance --subscription 61c871ca-30f7-43ef-a9c7-910fa8c0a5a5`.

**Rotar el token:** en BotFather `/revoke` (elige el bot; el token viejo deja de servir de inmediato) → copia el nuevo → corre `scripts/telegram-setup.sh`
(pega el token nuevo cuando pregunte si reutilizas el guardado; con token nuevo hay que registrar el webhook otra vez). **Cambiar autorizados o grupos:**
correr el script, aceptar reutilizar el token y escribir la lista nueva (el secreto se conserva, así que el webhook registrado sigue valiendo).
**Rotar el secreto del webhook:** `scripts/telegram-setup.sh --rotate-secret` y registrar el webhook. **Apagar el bot:** `scripts/telegram-setup.sh --delete-webhook`.

## 12. Metas de ahorro y predicción

- **Dónde**: panel "Metas de ahorro" en el inicio (crear, editar, eliminar) y página `/metas` (análisis completo). Hasta 20 metas; cada una con nombre, tipo, prioridad (alta/normal/baja), monto, ahorrado hoy y fecha (exacta o solo mes → último día del mes). Tabla `savings_goals` (migración 011 agregó `kind`, `priority`, `month_only`, `created_at`).
- **Predicción** (`src/lib/goals.ts`, pura): excedente mensual = ingreso mensual − gasto típico (promedio de los últimos 3 meses cerrados; el primer mes con datos se descarta si empezó después del día 7; sin meses cerrados usa la proyección del mes en curso). El excedente se reparte en **cascada** por prioridad y luego fecha: una meta llega a tiempo si lo acumulado hasta ella cabe antes de su fecha. Estados: lograda, a tiempo, a tiempo pero justa (un mes de gasto alto la atrasa), se retrasa, no alcanza (>10 años), vencida. Calcula cuánto falta liberar al mes, escenarios de recorte (0/10/20 %) y una idea de recorte por categoría (excluye gastos fijos).
- **Alertas**: `goal_off_track` evalúa cada meta, repartiendo el ahorro proyectado del mes entre ellas por prioridad (aviso semanal por meta: `goal:<id>:<semana>`).
- **Resumen con IA** (`/metas`, botón "Generar resumen"): OpenRouter chat (`OPENROUTER_API_KEY`, la misma del categorizador; modelo `GOALS_LLM_MODEL`, por omisión `anthropic/claude-haiku-5.5`, ≈ US$0.001 por resumen). Solo se envían cifras agregadas ya calculadas (ingreso, gasto típico, metas, categorías con promedio): nunca comercios, tarjetas ni descripciones. Se pide `data_collection: deny` a OpenRouter, se verifica que cada monto del texto exista en las cifras enviadas (si no, un reintento y luego se descarta) y se guarda en `app_settings.goals_recap`. Máx. 8 por hora. Es a pedido: nunca se llama al modelo solo por abrir la página.

## 13. Trampas conocidas

- `sed -i` en macOS necesita `sed -i ''`. Los scripts temporales van al scratchpad, no a `/tmp`.
- Cada migración SQL corre en un solo lote: DDL sobre columnas nuevas dentro de `EXEC('…')`.
- Dos compras idénticas (misma tarjeta y monto) a menos de 15 min pueden cruzarse al fusionar Atajo↔correo (límite conocido).
- `DB_AUTH=token` (+ `AZURE_SQL_TOKEN`) existe solo para scripts de administración desde tu equipo; la app en Azure usa `msi`.
- `resetDb()` de las pruebas borra planes antes que tarjetas (FK). Migraciones de Fase F: `006` (esquema) y `007` (categorías).
- Cambiar App Settings reinicia la app unos segundos.
- Las pruebas de integración recrean su base en cada corrida: para correr varias a la vez usa `TEST_DB_NAME=uzfinance_test_<x>`.
- Las pruebas de OCR dibujan PDFs con `@napi-rs/canvas` (necesita alguna fuente del sistema; en Linux, p. ej. DejaVu). Un monto sin separador
  de miles en una fuente negrita grande puede perder el punto: el parser lo rechaza (nunca lo interpreta), por eso las fixtures usan montos con coma.
- `rule` es palabra reservada de T-SQL: entre corchetes (`[rule]`).
