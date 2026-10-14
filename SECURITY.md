# Security policy

UzFinance handles sensitive financial data, so security reports are taken seriously.

## Reporting a vulnerability

**Please don't open a public issue.** Use GitHub's private reporting instead:
**Security → Report a vulnerability** on <https://github.com/Aplex2723/UzFinance/security/advisories/new>.

Include what you found, how to reproduce it (with invented data only) and the impact you foresee. You'll get an acknowledgement within a few days; fixes for confirmed issues are prioritised over features.

## Scope

In scope: authentication/authorization bypasses, the ingestion and webhook endpoints (`/api/ingest*`, `/api/telegram`, `/api/whatsapp`), injection, SSRF, information leaks (logs, error messages), the CI/CD workflow files and the Azure deployment guidance.

Out of scope: vulnerabilities that require an already-compromised Azure account or device, denial of service by volume against a free-tier deployment, and issues in third-party services themselves.

## If you self-host

- Never commit `.env` files or tokens; secrets belong in App Settings.
- Keep `AUTH_MODE=easyauth` in production (the app refuses to start with `dev` there).
- Rotate `INGEST_TOKEN` if it leaks — see [docs/DEPLOY-AZURE.md](docs/DEPLOY-AZURE.md).
- Set an Azure budget and alerts; there is no hard spending cap.

See also the [security model](docs/SECURITY-MODEL.md).
