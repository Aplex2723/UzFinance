# Ingesta de correos de Banamex

Cómo se leen los avisos de Banamex desde Gmail y se fusionan con los gastos del Atajo.


Un Google Apps Script en tu Gmail (`integrations/gmail-apps-script/`, con su propia guía) envía cada 5 min los avisos de
`notificaciones@banamex.com` a `POST /api/ingest/email`. Cuerpo: `{messageId, from, subject, receivedAt, bodyText}`.

| Respuesta | Significado |
|---|---|
| `200 {status: created \| merged \| duplicate \| ignored \| unparsed}` | resultado idempotente (reenviar no duplica) |
| `400` payload inválido · `403` remitente distinto de `notificaciones@banamex.com` · `413` > 64 KB · `415` no JSON | |
| `401` token inválido · `429` demasiados intentos · `503` base despertando (reintentar) | |

`X-Dry-Run: 1` valida y reporta cómo se interpretaría (`parsed` / `ignored` / `unparsed` + motivo) sin escribir.

**Seguridad.** Token Bearer propio (varios con nombre, comparación en tiempo constante), distinto al del Atajo para revocarlos por
separado; fuera de Easy Auth; límite de 64 KB; 120 req/min por IP y bloqueo tras 10 tokens inválidos. El cuerpo del correo es entrada **no
confiable**: regex acotadas sobre etiquetas conocidas, nada se interpreta como instrucción, no se registra en logs y **no se guarda**
(solo campos interpretados + `messageId`). Un correo que no se entiende se guarda en `unparsed_emails` **sin cuerpo** (id, remitente,
asunto, fecha y motivo) y aparece en el dashboard como *Pendiente de revisión*.

**Parser** (`src/lib/sources/banamex-email.ts`, puro y probado con fixtures ficticios): despacha por asunto; lee la fila «Fecha y hora»
(no el encabezado) en 4 formatos, zona UTC-6 fija → se guarda en UTC; monto en centavos (acepta `$ 159.00 M.N.`; otra moneda → pendiente);
solo `Estatus = Exitoso` cuando existe. Comercio crudo + normalizado (sin sufijos de ciudad/país) → `category_rules`.

| Asunto | `kind` |
|---|---|
| Retiro/Compra con tarjeta Banamex / tarjeta adicional / cuenta Banamex | `expense` |
| Cargo a cuenta para pago a Establecimiento | `expense` recurrente; **`card_payment`** si el comercio es una tarjeta mía (lista editable en *Configuración → Domiciliaciones que son pago de tarjeta*; por defecto American Express / Amex) |
| Depósito a Cuenta o Tarjeta Banamex | `card_payment` (si es a una cuenta de débito, se ignora) |
| Alta/modificación de cuenta, NIP, preferencias, rechazos, límites, ahorro fácil, bienvenida | ignorado |

`card_payment` queda fuera de **todos** los totales y gráficas (si no, sumaría doble con las compras de la Amex) y se muestra en
*Pagos de tarjeta* (Inicio y `/transacciones?kind=card_payment`).

**Tarjetas.** Clave única = **producto + bandera de adicional + dígitos** (`EXPLORA-BANAMEX|ADIC|000`; el débito usa producto `DEBITO`). Si ya
tienes una tarjeta Banamex con esos dígitos se adopta; si no, se crea **sin nombrar** y el dashboard te pide nombrarla (y ponerle el alias de Wallet).
Las **domiciliaciones no crean tarjeta**: la «Cuenta de cargo» se guarda como referencia de la transacción (`account_ref`, se muestra
«Domiciliación ···NNN») y el cargo cuelga de una tarjeta de sistema llamada *Domiciliación*. Un **pago de tarjeta** por domiciliación se
liga a la tarjeta cuyos últimos dígitos coincidan con la «Referencia establecimiento» del correo (solo si es inequívoca; si no, a *Domiciliación*).
Fechas: se interpretan en la zona IANA de la app (`America/Mexico_City`, `src/lib/time.ts`) y se guardan en UTC.

**Fusión con el Atajo.** Misma tarjeta + mismo monto + ≤ 15 min → una sola transacción, en cualquier orden de llegada. El correo manda
(comercio, autorización, fecha, estatus) y la fila conserva `sources = shortcut,email`. Los reintentos del Atajo después de fusionar siguen
siendo duplicados (`merged_hashes`). Un Atajo en tarjeta Banamex sin correo tras 24 h se marca *Sin confirmación bancaria* (la Amex no aplica).
Límite conocido: dos compras idénticas (misma tarjeta y monto) a < 15 min entre sí pueden cruzarse si solo llega un correo.

**Tokens del puente.**

```bash
# crear (no lo pegues en chats ni en el repo)
openssl rand -base64 36 | tr '+/' '-_'
# publicar: nombre=token; para rotar, deja ambos un rato (gmail=NUEVO,viejo=ANTERIOR) y luego quita el viejo
az webapp config appsettings set -g rg-uzfinance -n <tu-app> --settings "EMAIL_INGEST_TOKENS=gmail=<token>"
```
