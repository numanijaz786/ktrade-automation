# Security Report

_Status as of 2026-11-19. Design: [docs/04](docs/04-security-and-credential-management.md). Decisions: ADR-013, 019, 021–024, 026, 032. ASVS L2 self-review: [docs/11](docs/11-security-review.md) (47 met, 10 partial, 2 not met, 3 N/A of 62)._

## Implemented and tested

| Control              | Implementation                                                                                                                                                         | Evidence                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Password storage     | Argon2id (m=64 MiB, t=3, p=1), rehash on parameter change                                                                                                              | auth.int: hash format asserted                             |
| Sessions             | Ed25519 JWT (15 min) + rotating opaque refresh token (SHA-256 at rest, httpOnly, SameSite=Strict, path-scoped)                                                         | auth.int: rotation, **reuse ⇒ whole session revoked**      |
| Immediate revocation | Guard checks the session is still live on every request                                                                                                                | auth.int: logout and password change kill the access token |
| 2FA                  | TOTP RFC 6238, ±1 step, **replay-protected**, secret envelope-encrypted                                                                                                | RFC vectors; auth.int enrol / login / replay               |
| Step-up              | 5-min token with its own audience for 🔐 routes (approve order, kill switch, risk limits, provider switch, password)                                                   | trading.int, market-data.int                               |
| Authorization        | Global default-deny guard chain; VIEWER read-only; resources scoped by owner (other users' watchlists → 404)                                                           | auth.int, market-data.int                                  |
| Brute force          | Rate limits (5/min on auth) **per real client IP**, 15-min lockout after 5 failures, constant-time unknown-user path                                                   | e2e, security.e2e, auth.int                                |
| Client IP            | nginx overwrites X-Real-IP/X-Forwarded-For; BFF forwards one validated hop only with `BFF_TRUST_PROXY=true`; API trusts XFF only from `TRUST_PROXY_ADDRESSES`          | handlers.test, security.e2e (spoofing ignored)             |
| Input validation     | Zod on every body/query/param; RFC 9457 errors; refinements hardened against Zod 4 continuation                                                                        | unit + int                                                 |
| Injection            | Prisma parameterised queries only; raw SQL uses tagged templates                                                                                                       | code review                                                |
| Secrets              | Env validated at boot (names only in errors); pino redaction; `.env*` gitignored; pre-commit secret scans                                                              | —                                                          |
| Encryption at rest   | AES-256-GCM envelope encryption, per-record DEK, AAD binding                                                                                                           | envelope tests (tamper, swap, wrong key)                   |
| Audit                | Append-only `audit_logs` and `order_events` (**DB triggers block UPDATE/DELETE/TRUNCATE**)                                                                             | auth.int, trading.int                                      |
| Trading safety       | Kill switch default OFF; 14 risk checks; approval bound to the preview hash; idempotency keys; no fill without a recorded fill; live refuses simulated or stale prices | trading.int                                                |
| Broker               | No KTrade credentials stored; automation adapters disabled behind a 4-flag capability chain                                                                            | broker-sdk tests                                           |
| Transport (dev)      | API binds 127.0.0.1; Helmet headers (also on body-parser errors, no X-Powered-By); CORS allow-list                                                                     | smoke test, security.e2e                                   |
| Transport (prod)     | nginx TLS 1.2/1.3, HSTS, CSP, only nginx publishes ports (ADR-032)                                                                                                     | ADR-032 local verification                                 |
| Supply chain         | 7-day minimum release age; install-script allow-list                                                                                                                   | ADR-002                                                    |

## Open items

1. ~~BFF and CSRF for the web app~~: **done** (ADR-026): httpOnly session cookies, double-submit CSRF + Origin check, no tokens in browser-visible bodies, refresh-once with a shared refresh.
2. **Credential vault endpoints** (write-only secrets) and **"destroy all"**: designed, not yet built.
3. ~~TLS and Nginx, backups~~: **done** (ADR-032). Still open: production secrets in an OS keychain or secret manager, mandatory `age` encryption for off-host backups, host disk encryption.
4. **Rate-limit store** must move to Redis before running more than one API instance.
5. ~~Client IP behind the proxy~~: **done** (docs/11 finding 1). Rate limits and audit IPs are per real client.
6. ~~Dependency audit~~: **run 2026-11-19**, with 0 high/critical and 3 moderate (csv-parse prototype issue not exploitable, fix needs v7; glob/minimatch dev-only). Still open: add `pnpm audit --prod --audit-level high` to CI. gitleaks is in CI.
7. ~~Formal ASVS L2 review~~: **done** ([docs/11](docs/11-security-review.md)). Top gaps:
   - no absolute session lifetime (sliding 7-day refresh);
   - TOTP is optional for OWNER;
   - CSP `'unsafe-inline'`;
   - no breached-password check;
   - the API accepts urlencoded bodies;
   - internal hops are plaintext (single host, accepted).
