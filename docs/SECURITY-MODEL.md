# Modelo de seguridad

Controles que trae la app y la infraestructura. Para reportar una vulnerabilidad, ver [SECURITY.md](../SECURITY.md).


| Control | Cómo |
|---|---|
| Todo exige sesión | Easy Auth con Entra ID; **únicas excepciones** (`excludedPaths`): `/api/ingest` y `/api/ingest/email` (token Bearer propio), `/api/whatsapp` (verify token de Meta en GET y firma HMAC-SHA256 `X-Hub-Signature-256` del cuerpo crudo en POST) y `/api/telegram` (encabezado secreto `X-Telegram-Bot-Api-Secret-Token`, solo POST), más los estáticos públicos sin datos `/manifest.webmanifest` y `/icons/*` (necesarios para instalar la app en el celular). Los webhooks verifican la firma/secreto **antes** de leer el cuerpo y de aplicar límites por IP (una petición autenticada nunca se bloquea por IP; la IP de los límites es la última de `X-Forwarded-For`, la que agrega Azure), y solo aceptan remitentes de su lista blanca |
| Defensa en profundidad | El servidor valida `X-MS-CLIENT-PRINCIPAL` y compara el correo con `ALLOWED_EMAIL`. Match robusto del UPN de invitado (`usuario_gmail.com#EXT#@tenant`) además del claim `email`; y opcionalmente `tid` |
| Solo tu cuenta | Asignación de usuario obligatoria en la enterprise app + `allowedPrincipals` (tu object id) + `WEBSITE_AUTH_AAD_ALLOWED_TENANTS` + allowlist en código |
| Login sin secreto | Easy Auth usa una *federated identity credential* sobre una Managed Identity (no hay client secret) |
| Ingesta | Token largo aleatorio en `Authorization: Bearer`, comparación en tiempo constante, rate limit por IP (60/min y 10 tokens inválidos/10 min → 429), body máx. 8 KB, JSON estricto |
| Cuerpos grandes en rutas sin sesión | `proxy.ts` rechaza con 413 por `Content-Length` declarado antes de que Next copie el cuerpo en memoria: 256 KB en `/api/whatsapp` y `/api/telegram`, 64 KB en `/api/ingest*` (los PDF de la app van por `/api/documents`, con sesión) |
| `AUTH_MODE=dev` | Solo local. La app **se niega a arrancar** con dev en producción (o dentro de App Service); hay pruebas que lo verifican |
| Transporte y cabeceras | HTTPS only, TLS ≥ 1.2, HSTS, CSP con nonce, `X-Frame-Options: DENY`, `nosniff`, Referrer/Permissions-Policy, sin `X-Powered-By`; CORS cerrado |
| Anti-CSRF | Mutaciones rechazan `Origin` distinto del host; además exigen `application/json`/`text/csv` |
| Base de datos | Solo autenticación Entra (sin logins SQL ni passwords); la Managed Identity de la app tiene **solo `db_datareader` + `db_datawriter`** (sin DDL) |
| Despliegue | OIDC con credencial federada atada al repo/rama `main` (subject con IDs inmutables); rol *Website Contributor* solo sobre la Web App |
| Superficie de administración | FTPS deshabilitado, remote debugging apagado, credenciales básicas FTP/SCM deshabilitadas |
| Logs | No se registran payloads, montos ni el token; los errores 500 devuelven un mensaje genérico |
| Secretos | Solo como App Settings. Nada en el repo (`.env` ignorado; `.env.example` sin valores) |
| Presupuesto | Alerta de US$5/mes (50 %, 100 % real, 100 % proyectado) y alerta de cupo de la base gratuita |

> Los App Settings son visibles para quien tenga rol Owner/Contributor en la suscripción. Para un uso personal es suficiente; si quisieras más aislamiento, el siguiente paso sería Key Vault con referencias.
