# UzFinance: guía rápida (contexto para humanos y para una sesión nueva)

Tracker personal de gastos (Amex, Banamex, Nu). UI en español, MXN, tema oscuro, pensado para el iPhone.
Repo privado: `Aplex2723/UzFinance`. **Un push a `main` despliega a producción** (no hay staging).
Detalle largo en el [README](../README.md); esto es el resumen operativo.

## 1. Cómo funciona

```
Apple Pay ──► Atajo (automatización Wallet) ──POST /api/ingest────────┐
Gmail (avisos de Banamex) ──► Google Apps Script ──POST /api/ingest/email──┤
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
  `/api/ingest/email`, `/manifest.webmanifest`, `/icons/*`. Las demás exigen sesión.
- **Secretos:** solo como App Settings (`INGEST_TOKEN`, `EMAIL_INGEST_TOKENS="gmail=<token>"`) y en el Atajo / las propiedades del
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

## 9. Trampas conocidas

- `sed -i` en macOS necesita `sed -i ''`. Los scripts temporales van al scratchpad, no a `/tmp`.
- Cada migración SQL corre en un solo lote: DDL sobre columnas nuevas dentro de `EXEC('…')`.
- Dos compras idénticas (misma tarjeta y monto) a menos de 15 min pueden cruzarse al fusionar Atajo↔correo (límite conocido).
- `DB_AUTH=token` (+ `AZURE_SQL_TOKEN`) existe solo para scripts de administración desde tu equipo; la app en Azure usa `msi`.
- `resetDb()` de las pruebas borra planes antes que tarjetas (FK). Migraciones de Fase F: `006` (esquema) y `007` (categorías).
- Cambiar App Settings reinicia la app unos segundos.
