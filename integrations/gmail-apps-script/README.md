# Puente Gmail → UzFinance (Google Apps Script)

Lee **solo** los correos de `notificaciones@banamex.com` con asunto de transacción y los manda a
`POST /api/ingest/email`. Corre dentro de tu cuenta de Gmail cada 5 minutos. No hay servidor intermedio.

## Qué envía (y qué no)

Por cada correo: `messageId`, remitente, asunto, fecha de recepción y cuerpo en texto plano. Nada más
(sin adjuntos, sin HTML, sin otros remitentes). El script filtra por remitente exacto y por la lista de asuntos
de `SUBJECTS`: publicidad (`marketingdir@…`), estados de cuenta (`estadosdecuenta@…`) y alertas de fraude
(`prevenciondefraudes@…`) **nunca salen de Gmail**. La app tampoco guarda el cuerpo: solo los campos interpretados.

## Por qué Apps Script y no Gmail API + Pub/Sub

Verificado en la documentación de Google (oct 2026):

- Una app con pantalla de consentimiento *External* y estado **Testing** recibe refresh tokens que **caducan a los 7 días**
  ([OAuth 2.0 — Refresh token expiration](https://developers.google.com/identity/protocols/oauth2)). Con una cuenta
  `gmail.com` personal solo se evita publicando la app (y verificándola, porque Gmail es un alcance restringido).
- Gmail API/Pub/Sub exige un proyecto de Google Cloud, un endpoint público para el push y renovar el watch cada 7 días.
- Apps Script usa tu propia sesión: sin proyecto de Cloud propio, sin refresh tokens que caduquen.

## Instalación (≈5 minutos)

1. Entra a <https://script.google.com> con la cuenta de Gmail que recibe los avisos → **Nuevo proyecto** → nómbralo `UzFinance Gmail`.
2. Pega `Code.gs` en el editor (reemplaza el contenido). Opcional: *Configuración del proyecto → Mostrar el archivo de manifiesto*
   y copia `appsscript.json`.
3. **Propiedades del script** (ícono de engrane → *Propiedades de la secuencia de comandos* → *Agregar*):
   - `UZ_URL` = `https://<tu-app>.azurewebsites.net`
   - `UZ_TOKEN` = el token del puente Gmail (se genera con `openssl rand -base64 36 | tr '+/' '-_'`; ver [docs/BANAMEX-EMAIL.md](../../docs/BANAMEX-EMAIL.md)).

   El token **no va en el código**. Nunca lo pegues en un chat ni lo subas al repo.
4. Selecciona `testConnection` → **Ejecutar**. Autoriza cuando lo pida.
   > **Permiso:** Google pedirá *«Leer, redactar, enviar y eliminar permanentemente todos tus correos de Gmail»*
   > (`https://mail.google.com/`). Es el alcance que exige **cualquier** método de `GmailApp`, incluso para buscar y etiquetar;
   > no existe un alcance de solo lectura para este servicio. El script solo busca, lee y añade etiquetas
   > (revísalo: son ~150 líneas) y no envía correos ni borra nada. Si no te convence, ver «Alternativa de menor permiso».
   > Si aparece «Google no verificó esta aplicación»: *Avanzado → Ir a UzFinance Gmail (no seguro)*; es tu propio script.
5. El log muestra, del correo de transacción más reciente:
   - la **estructura enmascarada** del texto plano y del HTML (etiquetas legibles; letras → `x`, dígitos → `9`; nunca valores reales),
   - cuál se enviará (texto plano, o HTML si Gmail entregó el texto plano desordenado) y
   - `App → HTTP 200 {"status":"parsed",…,"dryRun":true}`: valida URL, token y que el parser entiende tu correo **sin escribir nada**.
     Si dice `unparsed`, el motivo (`falta Monto`, `Fecha y hora con formato desconocido`…) indica qué ajustar.

   Si hace falta ajustar el parser, pásame esa salida: no contiene datos tuyos.
6. **Backfill** (una vez): ejecuta `backfill()`. Procesa mensajes en orden cronológico y corta a los 4.5 min (límite de 6 min por
   ejecución). Si el log dice «Backfill incompleto», vuelve a ejecutarla: es idempotente y continúa donde se quedó
   (`resetBackfill()` la reinicia).
7. **Disparador:** ejecuta `installTrigger()` una vez (crea `processNew` cada 5 minutos). Verifícalo en el menú *Activadores*.

## Cómo funciona

- **Cada mensaje es independiente.** Banamex agrupa en un mismo hilo de Gmail correos con el mismo asunto (p. ej. dos compras
  del mismo día). El script recorre `getMessages()` de cada hilo y envía **cada mensaje** con su propio `messageId`.
  La etiqueta del hilo (`uzfinance-enviado`) es solo informativa: **no** decide qué se envía.
- **Qué ya se envió:** el script guarda un cursor (fecha del último mensaje resuelto) y los ids ya enviados en *Script Properties*.
  Cada corrida busca `from:notificaciones@banamex.com after:<cursor − 6 h>`, descarta lo ya enviado y manda el resto en orden
  cronológico. Un mensaje nuevo que llega a un hilo ya etiquetado se envía; un mensaje viejo no se reenvía.
  Sin mensajes nuevos **no hay llamadas a la app**, así que no despierta la base de datos gratuita.
- Por cada mensaje candidato: `POST` con el token en `Authorization: Bearer …`. Con **200** (incluye `duplicate`, `ignored`,
  `unparsed`) se da por enviado.
- **Reintentos:** 429/5xx o fallo de red → el mensaje no se marca, el script se detiene y la siguiente corrida lo reintenta (los
  anteriores no se reenvían). Un `503` (la base gratuita despertando) se reintenta 3 veces con 20 s de espera. Un `401` detiene
  el script con un error claro.
- **Rechazos permanentes** (400/403/413/415) etiquetan el hilo `uzfinance-rechazado`, no se reintentan y el script sigue con el siguiente.
- **Cuerpo:** se envía texto plano. Si Gmail lo entrega sin las etiquetas de la tabla (desordenado), el script reconstruye el texto
  desde el HTML (una celda por línea). Nunca se envía HTML.
- **Reprocesar** un correo (p. ej. tras mejorar el parser): borra la propiedad `SENT` (o ejecuta `resetBackfill()` y `backfill()`); la app
  ignora lo que ya tiene (idempotente) y reevalúa lo que estaba pendiente de revisión.
- Las pruebas del script (`tests/unit/apps-script.test.ts`) ejecutan este mismo `Code.gs` con dobles de Gmail: hilos de varios mensajes,
  reintentos, rechazos, backfill reanudable y el enmascarado de `testConnection()`.

## Cuotas (cuentas de consumidor, [documentación](https://developers.google.com/apps-script/guides/services/quotas))

| Límite | Valor | Uso estimado |
|---|---|---|
| Tiempo por ejecución | 6 min | el script se corta solo a los 4.5 min |
| Tiempo total de disparadores | 90 min/día | ~288 corridas × 1–2 s ≈ 5–10 min/día |
| Llamadas `UrlFetch` | 20,000/día | decenas |
| Lectura/escritura de correo | 20,000/día | cientos |
| Disparadores | 20 por script | 1 |

Google puede cambiar estos límites sin aviso.

## Revocar

- **Dejar de enviar:** ejecuta `removeTrigger()` (o borra el activador en *Activadores*).
- **Revocar el acceso a tu Gmail:** <https://myaccount.google.com/permissions> → *UzFinance Gmail* → *Quitar acceso*.
- **Revocar el token del puente:** quita su entrada de `EMAIL_INGEST_TOKENS` en la app (ver [docs/BANAMEX-EMAIL.md](../../docs/BANAMEX-EMAIL.md)); el script recibirá `401`.
- Borrar el proyecto de script elimina todo lo anterior. Las etiquetas `uzfinance-*` pueden borrarse a mano en Gmail.

## Alternativa de menor permiso

Si prefieres no dar `https://mail.google.com/`, existe el servicio avanzado *Gmail API* de Apps Script con
`gmail.readonly` + `gmail.modify`/`gmail.labels`; exige reescribir `Code.gs` con `Gmail.Users.Messages.*` y habilitar la API
en un proyecto de Cloud vinculado. No lo hice para mantener el puente simple; dime si lo quieres.
