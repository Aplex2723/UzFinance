# Arquitectura

Cómo está armado UzFinance y por dónde entran los datos.


```
 iPhone (Wallet/Apple Pay)                    Navegador (tú)
        │ disparador "Transacción"                  │ HTTPS
        ▼                                           ▼
   Atajo ── POST /api/ingest ───┐        ┌── App Service Authentication (Easy Auth)
   Authorization: Bearer <token>│        │   Entra ID · single-tenant · asignación obligatoria
                                ▼        ▼   (todo exige sesión, salvo excludedPaths: /api/ingest, /api/ingest/email, /api/mcp, /api/whatsapp, /api/telegram)
                     ┌──────────────────────────────────┐
                     │ Azure App Service F1 (Linux)     │
                     │ Next.js 16 (standalone, Node 24) │
                     │  · proxy.ts: sesión + CSP/nonce  │
                     │  · cada handler revalida sesión  │
                     └──────────────┬───────────────────┘
                                    │ Managed Identity (Entra), sin passwords
                                    ▼
                     Azure SQL Database (serverless, oferta gratuita, solo Entra)

 GitHub (main) ─ Actions: lint · typecheck · tests ─ OIDC (sin secretos) ─▶ deploy ─▶ smoke test
```

| Capa | Detalle |
|---|---|
| Web | Next.js 16 (App Router) + TypeScript + Tailwind v4; gráficas con Recharts y d3-sankey; validación con zod |
| Datos | SQL Server (Azure SQL en prod, SQL Server 2022 en docker local → mismo motor); consultas parametrizadas; montos en **centavos enteros**; reembolsos = monto negativo |
| Ingesta | `POST /api/ingest` → valida (zod estricto) → resuelve tarjeta (nombre, alias o últimos 4) → categoriza (reglas) → deduplica por hash |
| Fuentes | Interfaz `TransactionSource`: `shortcut` y `statement` (CSV genérico) implementadas. Correos de Banamex: ver [Ingesta de correos de Banamex](BANAMEX-EMAIL.md) |
| Categorización | Interfaz `Categorizer`: `CATEGORIZER=rules` (solo reglas) o `jev` (reglas → historial → [Jev](https://openrouter.ai/docs/guides/community/jev) vía OpenRouter, `src/lib/categorizer/jev.ts`) |
| Estados de cuenta y MSI | `scripts/statements` (extractores Python con verificación de totales) + `scripts/import-statements.ts`; planes a meses en `installment_plans` (página `/msi`). Ver [docs/GUIA.md §8](GUIA.md) |
| Tiempo real | `LiveRefresh` revisa `/api/changes` con la pestaña visible y actividad reciente, y al volver a la pestaña; refresca solo cuando algo cambió |

**Deduplicación:** hash SHA-256 de `tarjeta + minuto + monto + comercio normalizado` (Atajo/manual). Para estados de cuenta (solo traen día) es `tarjeta + día + monto + comercio`, y además se omite si ya existe un movimiento no-estado con misma tarjeta, día y monto.
