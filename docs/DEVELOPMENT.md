# Desarrollo local

Variables de entorno, cómo correr la app en tu máquina y las pruebas.

## Variables de entorno

Plantilla en [`.env.example`](../.env.example). En Azure son *App Settings*.

| Variable | Local | Azure | Descripción |
|---|---|---|---|
| `AUTH_MODE` | `dev` | `easyauth` | `dev` salta el login (solo local; bloqueado en producción) |
| `ALLOWED_EMAIL` | tu correo | tu correo | Allowlist del correo que puede entrar |
| `ALLOWED_TENANT_ID` | — | tenant | Si se define, el claim `tid` debe coincidir |
| `EMAIL_INGEST_TOKENS` | aleatorio | aleatorio | Tokens del puente Gmail, `nombre=token,otro=token` (cada token ≥ 32). **Distinto** de `INGEST_TOKEN`; sin definir, el endpoint rechaza todo |
| `MCP_TOKENS` | opcional | aleatorio | Tokens del servidor MCP (`/api/mcp`, solo lectura), `nombre=token,otro=token` (cada token ≥ 32). **Distinto** de `INGEST_TOKEN`; sin definir, el endpoint rechaza todo. Azure: `scripts/mcp-setup.sh` |
| `INGEST_TOKEN` | aleatorio | aleatorio | Token Bearer de `/api/ingest` (≥ 32 caracteres) |
| `INGEST_TOKEN_PREVIOUS` | — | solo en rotación | Token anterior aún válido durante la rotación |
| `CATEGORIZER` | `rules` | `rules` | `rules` o `jev` |
| `OPENROUTER_API_KEY` | — | — | API key de OpenRouter para Jev, los resúmenes con IA y UzChat (secreto: App Setting en Azure) |
| `CHAT_LLM_MODEL` | — | — | Modelo de UzChat (con soporte de herramientas); por omisión `GOALS_LLM_MODEL` o `anthropic/claude-haiku-5.5` |
| `DB_SERVER`, `DB_PORT`, `DB_NAME` | `localhost`, 1433, `uzfinance` | `<srv>.database.windows.net`, —, `uzfinance` | Conexión |
| `DB_AUTH` | `password` | `msi` | `msi` = Managed Identity (sin passwords) |
| `DB_USER`, `DB_PASSWORD`, `DB_SA_PASSWORD` | docker local | — | Solo local |
| `DB_TRUST_SERVER_CERT` | `true` | `false` | Certificado del SQL local |
| `HOSTNAME`, `PORT`, `WEBSITES_PORT` | — | `0.0.0.0`, `8080`, `8080` | Necesarios para el servidor standalone en App Service |
| `OVERRIDE_USE_MI_FIC_ASSERTION_CLIENTID` | — | client id de la identidad | Easy Auth sin secreto |

## Correr en local

Requisitos: Node 24 y Docker (OrbStack o Docker Desktop).

```bash
cp .env.example .env     # completa INGEST_TOKEN, DB_PASSWORD y DB_SA_PASSWORD (mismo valor)
npm ci
npm run db:up            # SQL Server 2022 en docker (solo en 127.0.0.1)
npm run db:migrate && npm run db:seed
npm run dev              # http://localhost:3000  (AUTH_MODE=dev, sin login)
```

`npm run db:reset` borra y recrea la base local con datos de ejemplo. `seed` y `reset` **se niegan a correr** contra cualquier cosa que no sea la base local de docker.

Probar la ingesta en local:

```bash
curl -X POST localhost:3000/api/ingest \
  -H "Authorization: Bearer $(grep ^INGEST_TOKEN= .env | cut -d= -f2)" \
  -H "Content-Type: application/json" \
  -d '{"merchant":"OXXO","amount":"45.50","card":"Banamex Oro"}'
```

Contrato de `/api/ingest` (claves desconocidas se rechazan):

| Campo | Tipo | Notas |
|---|---|---|
| `merchant` | texto 1–120 | Comercio tal como lo manda Wallet |
| `amount` | texto o número | `"$1,234.50"`, `"MXN 99"`, `12.5`; reembolsos negativos |
| `card` | texto 1–80 | Nombre en Wallet, alias o últimos 4 |
| `date` | ISO 8601 con zona (opcional) | Si falta, hora del servidor |
| `notes` | texto ≤ 500 (opcional) | |

Respuestas: `200` `{"status":"inserted"\|"duplicate"}`, `400` validación, `401` token, `413` body grande, `415` content-type, `429` rate limit, `503` base despertando (reintentar). Cabecera opcional `X-Dry-Run: 1` valida sin escribir.

## Pruebas

```bash
npm run lint && npm run typecheck
npm run test:unit          # lógica pura: allowlist, token, dinero, CSV, reglas…
npm run test:integration   # API + SQL Server real (requiere db:up); base aparte `uzfinance_test`
npm run test:e2e           # build de producción + Playwright (desktop y mobile); base `uzfinance_e2e`
```

El e2e (solo local; ya no corre en CI para que el despliegue sea rápido) corre sobre el **build de producción** con `AUTH_MODE=easyauth` y el header de Easy Auth simulado, así se ejercita el mismo camino de seguridad que en Azure. Las capturas de diseño se regeneran en `docs/screenshots/`.

CI (`.github/workflows/ci.yml`) corre todo esto con un SQL Server efímero y password generado al vuelo.
