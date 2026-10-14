# Contributing to UzFinance

Thanks for helping! *(Puedes escribir issues y PRs en español o en inglés.)*

## Ground rules

1. **Never include real financial data.** No real statements, receipts, card digits, names, e-mails or account numbers — not in issues, screenshots, test fixtures or commit history. Every fixture must be invented. If you need to show a parser bug, redact or fabricate a minimal sample.
2. **Money is integer cents** (`BIGINT`). Never use floats for amounts.
3. **No LLM touches financial figures.** Statement/receipt numbers come from deterministic extractors with checks. LLMs may only see already-aggregated or non-sensitive text (e.g. a merchant name), and are always optional.
4. **Security first.** Anything reachable without a session needs its own authentication (see [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md)). Don't log payloads, amounts or tokens.
5. **Next.js 16 is not the Next.js you know.** APIs and conventions changed. Read the relevant guide in `node_modules/next/dist/docs/` before writing Next-specific code (see [AGENTS.md](AGENTS.md)).

## Setup

```bash
cp .env.example .env     # fill DB_PASSWORD, DB_SA_PASSWORD (same value) and INGEST_TOKEN
npm ci
npm run db:up && npm run db:migrate && npm run db:seed
npm run dev
```

You need Node 24 and Docker. More in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Before you open a PR

```bash
npm run lint && npm run typecheck
npm run test:unit          # pure logic, no database
npm run test:integration   # API + a real SQL Server (needs `npm run db:up`)
npm run test:e2e           # optional: production build + Playwright
```

CI runs lint, typecheck, unit and integration tests and a production build on every PR. Add tests for what you change; bug fixes should come with a test that fails without the fix.

- Keep PRs focused and small; explain **why** in the description.
- Match the surrounding style (the code and UI strings are in Spanish where user-facing; identifiers are English).
- Database changes are **new numbered files** in `db/migrations/` that are backwards compatible (add, don't break). Never edit an applied migration.
- UI changes: attach a screenshot made with the seeded demo data (`npm run docs:screenshots` regenerates the README images).

## Good first contributions

- **A new bank/issuer parser** (BBVA, Santander, HSBC, Banorte, Hey Banco…) — see `src/lib/pdf/statements` and `src/lib/sources`. Send fabricated fixtures only.
- **Translations / i18n.** The UI is Spanish-only today; extracting strings is a welcome first step.
- **Other currencies and countries.**
- Documentation fixes and English translations of the `docs/` guides.

## Deployments

The maintainer deploys from `main` through GitHub Actions. Forks and PRs only run CI: the deploy job is skipped unless the repository has Azure variables configured, so you can't (and don't need to) deploy from a PR.

## Reporting security issues

Please don't open a public issue. See [SECURITY.md](SECURITY.md).
