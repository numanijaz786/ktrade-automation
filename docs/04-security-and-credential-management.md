# 04 — Security & Credential Management

_Threat model: a single owner, self-hosted, managing a real brokerage account. The worst outcomes are (1) an attacker placing trades or reading financial data, (2) the app placing an unintended trade, and (3) silently wrong financial figures._

## 1. Principles

1. **Hold as few secrets as possible.** The best secret is one we never store. KTrade/PSX credentials and OTPs are **never stored**. Any future browser login is completed by you, in person (see [03](03-browser-automation-investigation.md) §5).
2. **Secrets never cross the API boundary.** No endpoint returns a token, cookie, key, password or browser profile, even in redacted form.
3. **Local-only during development.** Every service binds to `127.0.0.1`. Nginx exposes only the web app, and only behind TLS. The browser agent (if ever enabled) has no network listener.
4. **Everything sensitive is audited.** The audit log is append-only.

## 2. Secret inventory

| Secret                                                                                                   | Where it lives                                                                                                                                              | Protection                                                                |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| App master key (KEK)                                                                                     | OS keychain (Windows Credential Manager / macOS Keychain / libsecret) through `keytar`, or the `APP_MASTER_KEY` env var from a secret manager in deployment | Never in `.env` committed files, never in the DB                          |
| JWT signing keys                                                                                         | Env / secret manager; EdDSA (Ed25519) key pair, rotatable with a `kid`                                                                                      | Access token 15 min                                                       |
| Refresh tokens                                                                                           | DB stores **only the SHA-256 hash** plus family id                                                                                                          | Rotation on every use; reuse → revoke the whole family and force re-login |
| User password (app login)                                                                                | DB, **Argon2id** (m=64 MiB, t=3, p=1)                                                                                                                       | Login rate-limited; lockout with backoff                                  |
| TOTP 2FA secret (app login)                                                                              | DB, encrypted (envelope)                                                                                                                                    | Required for trade approval and settings changes                          |
| Third-party API keys (market-data vendor, SMTP, Telegram bot, LLM provider, mailbox OAuth refresh token) | `credentials_vault` table, **AES-256-GCM** envelope encryption: a per-record DEK wrapped by the KEK, AAD = `user_id                                         | provider                                                                  | record_id` | Decrypted only in-process, just in time; never logged |
| Browser profile (future, only if authorized)                                                             | Separate directory owned by the OS user, ACL-restricted, encrypted at rest (DPAPI on Windows)                                                               | One-click destroy; never mounted into the API container                   |
| KTrade / PSX password, PIN, OTP                                                                          | **Not stored. Ever.**                                                                                                                                       | You enter them directly into KTrade's own page                            |

## 3. Credential entry ("secure local configuration interface")

- Secrets are entered **only** on the app's local **Settings → Integrations** page, over HTTPS on localhost, into write-only fields. After saving, the UI shows only `•••• set on 2026-11-13` with **Replace** and **Delete** buttons. There is no "reveal" option.
- **Never paste credentials into chat, the editor, issue trackers or commit messages.** The project docs and this assistant never ask for them.
- Saving or deleting a credential requires TOTP re-authentication and writes an audit event (`credential.created|replaced|deleted`, recording provider and actor, never the value).

## 4. Repository hygiene

- `.gitignore` covers `.env*` (except `.env.example`), `*.pem`, `*.key`, `/secrets/`, `/browser-profiles/`, `/storage/`, `*.eml`, and uploaded statements.
- `.env.example` contains **names only**, with placeholder values.
- A pre-commit hook (`gitleaks protect --staged`) and a CI `gitleaks detect` job are blocking.
- Uploaded statements and contract notes go to `storage/imports/` encrypted with the vault DEK. Original files are deleted after a configurable retention period (default 90 days), and the parsed rows are kept.

## 5. Application security controls

| Area          | Control                                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Auth          | JWT access (memory/httpOnly via BFF), rotating refresh cookie (`HttpOnly; Secure; SameSite=Strict; Path=/api/auth`), optional TOTP, **step-up re-auth** for order approval, kill-switch off, credential and risk-limit changes |
| Sessions      | Sessions are listed in Security Settings; a single session or all of them can be revoked; idle timeout 30 min; absolute 7 days                                                                                                 |
| RBAC          | `OWNER` (everything) and `VIEWER` (read-only: no orders, settings or credentials)                                                                                                                                              |
| CSRF          | SameSite=Strict, plus a double-submit token on every state-changing BFF route                                                                                                                                                  |
| XSS           | React escaping, no `dangerouslySetInnerHTML`, strict CSP (`default-src 'self'`, nonce-based scripts), and imported text treated as data                                                                                        |
| Injection     | Prisma parameterized queries only; `$queryRawUnsafe` banned by lint; uploads validated by Zod per row                                                                                                                          |
| Uploads       | Size cap, MIME and magic-byte check, parsing in a worker with a timeout, no macro execution (XLSX through exceljs, PDF text extraction only)                                                                                   |
| Rate limiting | Redis throttler: login 5/min/IP, order preview 30/min, approve 10/min, assistant 20/min                                                                                                                                        |
| Transport     | Nginx TLS 1.2+, HSTS, `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, `frame-ancestors 'none'`                                                                                                 |
| Logging       | pino with redaction paths (`*.password`, `*.token`, `authorization`, `cookie`, `*.secret`, account numbers masked); no request bodies on auth or credential routes                                                             |
| AI assistant  | Read-only tools only, no access to the vault or trading tools; prompts and results exclude secrets; portfolio data is sent to the LLM provider only after you opt in, with provider shown                                      |

## 6. Trading-specific safeguards

- **Global kill switch** (`system_settings.trading_enabled=false` by default). It is checked server-side on every order transition, and switching it **on** requires TOTP.
- Order approval needs step-up auth and a server-generated **preview hash**. Approval is rejected if any previewed field (symbol, side, qty, price, fees estimate) changed, or if the preview is older than 5 minutes.
- Idempotency key per order (DB unique constraint).
- Risk limits (max order value and qty, daily value and count, price-band guard) are enforced in one DB transaction with row locking.
- Statuses distinguish `USER_REPORTED`, `BROKER_DISPLAYED` and `BROKER_CONFIRMED`. Nothing is shown as executed on the strength of a click.

## 7. Disconnect & destroy

**Settings → Integrations → Disconnect** (per integration), and **Security → Destroy all sessions & integration data**:

1. Revokes OAuth grants where the provider supports revocation (e.g. mailbox).
2. Deletes the vault records and their wrapped DEKs (crypto-shredding).
3. For a browser profile: closes the agent, deletes the profile directory, and deletes its key.
4. Revokes all app refresh-token families.
5. Writes an audit event. Afterwards, a check confirms that no artifacts remain.

## 8. Audit events (minimum set)

`auth.*` (login, failure, refresh-reuse, 2FA), `credential.*`, `integration.connected|disconnected`, `import.uploaded|committed|rejected`, `order.previewed|approved|rejected_by_risk|placed_manually|fill_recorded|reconciled|cancelled`, `killswitch.toggled`, `settings.risk_limits_changed`, `strategy.activated|deactivated|signal`, `export.generated`. Each event records actor, IP, user agent, entity, before/after (secrets excluded) and request id.

## 9. Backups & incident response

- Daily encrypted `pg_dump` (age/GPG). The KEK is backed up separately from the data, and a restore test runs monthly.
- **If you suspect compromise:** flip the kill switch, run "Destroy all sessions", change your KTrade password and PIN through KTrade, and notify KTrade immediately (as Online Trading Terminal Agreement §2 requires).
