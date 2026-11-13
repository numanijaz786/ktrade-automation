# Security Report

_Status as of 2026-11-14. Design: [docs/04](docs/04-security-and-credential-management.md). Decisions: ADR-013, 019, 021–024._

## Implemented and tested

| Control              | Implementation                                                                                                                                                         | Evidence                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Password storage     | Argon2id (m=64 MiB, t=3, p=1), rehash on parameter change                                                                                                              | auth.int: hash format asserted                             |
| Sessions             | Ed25519 JWT (15 min) + rotating opaque refresh token (SHA-256 at rest, httpOnly, SameSite=Strict, path-scoped)                                                         | auth.int: rotation, **reuse ⇒ whole session revoked**      |
| Immediate revocation | Guard checks the session is still live on every request                                                                                                                | auth.int: logout and password change kill the access token |
| 2FA                  | TOTP RFC 6238, ±1 step, **replay-protected**, secret envelope-encrypted                                                                                                | RFC vectors; auth.int enrol / login / replay               |
| Step-up              | 5-min token with its own audience for 🔐 routes (approve order, kill switch, risk limits, provider switch, password)                                                   | trading.int, market-data.int                               |
| Authorization        | Global default-deny guard chain; VIEWER read-only; resources scoped by owner (other users' watchlists → 404)                                                           | auth.int, market-data.int                                  |
| Brute force          | Rate limits (5/min on auth), 15-min lockout after 5 failures, constant-time unknown-user path                                                                          | e2e, auth.int                                              |
| Input validation     | Zod on every body/query/param; RFC 9457 errors; refinements hardened against Zod 4 continuation                                                                        | unit + int                                                 |
| Injection            | Prisma parameterised queries only; raw SQL uses tagged templates                                                                                                       | code review                                                |
| Secrets              | Env validated at boot (names only in errors); pino redaction; `.env*` gitignored; pre-commit secret scans                                                              | —                                                          |
| Encryption at rest   | AES-256-GCM envelope encryption, per-record DEK, AAD binding                                                                                                           | envelope tests (tamper, swap, wrong key)                   |
| Audit                | Append-only `audit_logs` and `order_events` (**DB triggers block UPDATE/DELETE/TRUNCATE**)                                                                             | auth.int, trading.int                                      |
| Trading safety       | Kill switch default OFF; 14 risk checks; approval bound to the preview hash; idempotency keys; no fill without a recorded fill; live refuses simulated or stale prices | trading.int                                                |
| Broker               | No KTrade credentials stored; automation adapters disabled behind a 4-flag capability chain                                                                            | broker-sdk tests                                           |
| Transport (dev)      | API binds 127.0.0.1; Helmet headers; CORS allow-list                                                                                                                   | smoke test                                                 |
| Supply chain         | 7-day minimum release age; install-script allow-list                                                                                                                   | ADR-002                                                    |

## Open items (before any public deployment)

1. **BFF and CSRF for the web app:** the browser currently runs only the demo client. The real-API client must go through a server-side BFF (httpOnly cookies, CSRF token) before going live.
2. **Credential vault endpoints** (write-only secrets) and **"destroy all"**: designed, not yet built.
3. **TLS and Nginx, production secrets** (OS keychain / secret manager), **backups**: Phase 12.
4. **Rate-limit store** must move to Redis before running more than one API instance.
5. **Dependency audit** (`pnpm audit`) and **gitleaks** in CI are configured but not yet run on GitHub.
6. A formal review (OWASP ASVS L2 checklist) is scheduled for Phase 12.
