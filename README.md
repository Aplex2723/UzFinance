# UzFinance

Tracker personal de gastos (Amex y Banamex). Los gastos entran desde un Atajo de iPhone (disparador *Transacción* de Wallet) y se consultan en un dashboard web.

> Documentación completa (arquitectura, despliegue en Azure, rotación de token, guía del Atajo) en la Fase C. Esta es la guía rápida local.

## Local

Requisitos: Node 24, Docker (OrbStack / Docker Desktop).

```bash
cp .env.example .env          # completa INGEST_TOKEN, DB_PASSWORD y DB_SA_PASSWORD (mismo valor)
npm ci
npm run db:up                 # SQL Server 2022 en docker
npm run db:migrate && npm run db:seed
npm run dev                   # http://localhost:3000  (AUTH_MODE=dev)
```

## Pruebas

```bash
npm run lint && npm run typecheck
npm run test:unit
npm run test:integration      # requiere `npm run db:up`
npm run test:e2e              # build de producción + Playwright (capturas en docs/screenshots)
```

![Dashboard](docs/screenshots/dashboard-desktop.png)
