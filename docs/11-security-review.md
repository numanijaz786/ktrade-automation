# 11 · Security self-review (OWASP ASVS 4.0.3, Level 2)

_Review date: 2026-11-19. Scope: `apps/api`, `apps/web` BFF (`src/lib/bff`, `src/proxy.ts`), `infra/` (nginx, prod compose, Dockerfiles), supply chain. This is a self-review by the project's security engineer, not an independent audit or a penetration test. Related: [docs/04](04-security-and-credential-management.md), [SECURITY_REPORT.md](../SECURITY_REPORT.md), ADR-019, ADR-026, ADR-032._

Status key: **Met** · **Partial** (control exists but with a gap) · **Not met** · **N/A** (feature not present).
Only requirements relevant to this system are listed. It is a single-user app on one VPS, with no file storage on disk, no SSO, no email recovery and no third-party API consumers.

## Summary

| Chapter                     | Met    | Partial | Not met | N/A   |
| --------------------------- | ------ | ------- | ------- | ----- |
| V2 Authentication           | 7      | 1       | 1       | 1     |
| V3 Session management       | 6      | 2       | 0       | 0     |
| V4 Access control           | 4      | 1       | 0       | 0     |
| V5 Validation & encoding    | 4      | 1       | 0       | 1     |
| V7 Errors & logging         | 6      | 0       | 0       | 0     |
| V8 Data protection          | 4      | 2       | 0       | 0     |
| V9 Communications           | 2      | 0       | 1       | 0     |
| V10 Malicious code / supply | 3      | 0       | 0       | 0     |
| V12 Files & resources       | 2      | 0       | 0       | 1     |
| V13 API                     | 4      | 1       | 0       | 0     |
| V14 Configuration           | 5      | 2       | 0       | 0     |
| **Total (62 requirements)** | **47** | **10**  | **2**   | **3** |

Fixed during this review (with tests): real client IP end to end (finding 1); security headers and no `X-Powered-By` on body-parser rejections; a proper reason-phrase `title` on generic HTTP errors; `X-Forwarded-Host` is honoured by the BFF's Origin check only behind the trusted proxy.

## V2 Authentication

| #           | Requirement                                    | Status  | Evidence / gap                                                                                                                                                                                                                                                  |
| ----------- | ---------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1.1–2.1.3 | Passwords 12–128 chars, no truncation          | Met     | `packages/shared/src/schemas/auth.ts` (`passwordSchema`)                                                                                                                                                                                                        |
| 2.1.7       | Check against breached passwords               | Not met | No breached-password check. **Rec:** add an offline top-100k list check (no network call) to `passwordSchema` / register / change-password.                                                                                                                     |
| 2.1.9       | No composition rules                           | Met     | Length only                                                                                                                                                                                                                                                     |
| 2.2.1       | Anti-automation (rate limit, lockout)          | Met     | Throttler 5/min on login, register and step-up; 15-min lock after 5 failures (`auth/password-policy.ts`); nginx `limit_req` per IP. Rate limits are now **per real client** (finding 1). Tests: `test/app.e2e.test.ts`, `test/security.e2e.test.ts`, `auth.int` |
| 2.2.3       | Notify the user of auth events                 | Partial | Audited (`auth.login`, `auth.login_failed`, `auth.password_changed`, `auth.totp_*`, `auth.refresh_reuse_detected`), shown in sessions, but no out-of-band notification. **Rec:** route these to the notifications module once SMTP/Telegram exists.             |
| 2.4.1/2.4.4 | Argon2id storage, rehash                       | Met     | `auth/password-policy.ts` (m=64 MiB, t=3, p=1); `auth.int` asserts hash format                                                                                                                                                                                  |
| 2.2.2/2.5.4 | No default or shared accounts                  | Met     | Registration closes after the first OWNER (SERIALIZABLE check, ADR-019)                                                                                                                                                                                         |
| 2.5.1–2.5.7 | Credential recovery                            | N/A     | No reset flow by design (single user). Recovery is operator-run (DB). Documented in docs/04.                                                                                                                                                                    |
| 2.8.1–2.8.4 | TOTP: time-based, single use, secret protected | Met     | `security/totp.ts` (RFC 6238 vectors, ±1 step, last step persisted against replay), secret envelope-encrypted                                                                                                                                                   |
| 2.2.7/2.7.x | Unknown-user timing / enumeration              | Met     | Dummy hash and identical error for unknown emails (ADR-019)                                                                                                                                                                                                     |

## V3 Session management

| #           | Requirement                                   | Status  | Evidence / gap                                                                                                                                                                                                                                                    |
| ----------- | --------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1.1       | Tokens never in URLs                          | Met     | Bearer header and cookies only; nginx log format omits the query string                                                                                                                                                                                           |
| 3.2.1/3.2.2 | New token on login, ≥ 64 bits of entropy      | Met     | 256-bit refresh tokens, fresh family per login (`auth/token.service.ts`)                                                                                                                                                                                          |
| 3.2.3       | Tokens stored safely in the browser           | Met     | httpOnly cookies only; step-up token kept in memory (ADR-026); `handlers.test.ts` asserts no token in bodies                                                                                                                                                      |
| 3.3.1       | Logout and expiry invalidate                  | Met     | The guard checks the session is live on every request; `auth.int` covers logout and password change                                                                                                                                                               |
| 3.3.2       | Periodic re-authentication / absolute timeout | Partial | Access 15 min. The refresh TTL (7 d) **slides on every rotation**, so an active session never has to re-authenticate. **Rec:** an absolute family lifetime (e.g. 7 d from the first `issuedAt` of the family) checked in `AuthService.refresh`, with an int test. |
| 3.3.4       | View and terminate sessions                   | Met     | `GET/DELETE /auth/sessions` (`auth.session_revoked`, `auth.sessions_revoked_all`)                                                                                                                                                                                 |
| 3.4.1–3.4.5 | Cookie Secure / HttpOnly / SameSite / Path    | Partial | All set (`lib/bff/cookies.ts`, `auth.controller.ts`; Secure in prod). The `__Host-` prefix isn't used (3.4.4). **Rec:** rename the cookies to `__Host-ktrade_*` with `Path=/`. That requires widening the path, so weigh it against today's `/bff` scoping.       |
| 3.5.3/3.7.1 | Signed tokens, alg pinned; re-auth for 🔐 ops | Met     | `jwtVerify` with `algorithms: ['EdDSA']`, issuer and audience; step-up token has its own audience (`trading.int`, `market-data.int`)                                                                                                                              |

## V4 Access control

| #           | Requirement                           | Status  | Evidence / gap                                                                                                                                                                                                                                 |
| ----------- | ------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1.1/4.1.5 | Server-side enforcement, fails closed | Met     | Global guards Throttler → JwtAuth → Roles → StepUp (`app.module.ts`, `auth/guards.ts`)                                                                                                                                                         |
| 4.1.3       | Least privilege; default deny         | Met     | `@Public()` opt-out only; VIEWER read-only unless `@AllowViewerWrite()`                                                                                                                                                                        |
| 4.2.1       | IDOR protection                       | Met     | Owner-scoped queries; other users' resources → 404 (`market-data.int`, `auth.int`)                                                                                                                                                             |
| 4.2.2       | CSRF                                  | Met     | Double-submit + Origin check on every non-GET BFF call (`handlers.test.ts`); refresh cookie SameSite=Strict                                                                                                                                    |
| 4.3.1       | MFA for administrative interfaces     | Partial | TOTP is available and step-up guards 🔐 routes, but TOTP isn't mandatory for OWNER. The role comes from the JWT, so a role change applies within ≤ 15 min. **Rec:** require TOTP enrolment before LIVE mode or the kill switch can be enabled. |

## V5 Validation, sanitisation and encoding

| #           | Requirement                                | Status  | Evidence / gap                                                                                                                                                                                                                                                                                                                                                                         |
| ----------- | ------------------------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.1.3/5.1.4 | Positive, schema-based input validation    | Met     | Zod on every body, query and param (`common/pipes/zod-validation.pipe.ts`); hardened refinements (`common/zod-refinements.test.ts`)                                                                                                                                                                                                                                                    |
| 5.1.5       | Safe redirects                             | Met     | BFF upstream fetch uses `redirect: 'manual'`; no user-controlled redirects                                                                                                                                                                                                                                                                                                             |
| 5.3.3       | Output encoding (XSS)                      | Met     | React auto-escaping; no `dangerouslySetInnerHTML` with user data; CSP (see V14)                                                                                                                                                                                                                                                                                                        |
| 5.3.4       | Parameterised queries                      | Met     | Prisma; raw SQL only through tagged templates                                                                                                                                                                                                                                                                                                                                          |
| 5.5.x       | Safe deserialisation / prototype pollution | Partial | JSON only. `csv-parse@6.2.1` has GHSA-8cw4-87c7-c6xx (moderate, header → `__proto__`), and the fix is only in v7. Not exploitable today: `normaliseHeader` turns `__proto__`/`constructor` into non-strings, which csv-parse rejects (→ 422 `PARSE_FAILED`, verified). **Rec:** upgrade to csv-parse 7 and use `Object.hasOwn(ALIASES, …)` in `imports/parsers/generic-csv.parser.ts`. |
| 5.2.x       | Formula/CSV injection in exports           | N/A     | No CSV/XLSX export yet. Escape `=+-@` when exports land.                                                                                                                                                                                                                                                                                                                               |

## V7 Error handling and logging

| #           | Requirement                               | Status | Evidence / gap                                                                                                                                                                                                                                         |
| ----------- | ----------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 7.1.1/7.1.2 | No secrets or session tokens in logs      | Met    | pino `REDACT_PATHS` (`common/logging/logger.module.ts`); minimal req serializer; audit `scrubSecrets`                                                                                                                                                  |
| 7.1.3/7.2.1 | Security events logged (auth, access, 🔐) | Met    | `audit_logs` for every auth event, kill switch, risk limits, provider switch, orders                                                                                                                                                                   |
| 7.1.4       | Enough context (who, when, where)         | Met    | Audit `ip` is now the **real client IP** (finding 1), plus user agent and request id                                                                                                                                                                   |
| 7.3.3/7.3.4 | Log integrity                             | Met    | DB triggers block UPDATE/DELETE/TRUNCATE on `audit_logs` and `order_events`                                                                                                                                                                            |
| 7.4.1       | Generic error messages, no stack traces   | Met    | RFC 9457 filter; unknown errors → generic 500. **Fixed:** body-parser 400/413 responses now carry Helmet headers and no `X-Powered-By`, and a bare `HttpException` gets the status reason phrase as title (was `"Http"`) (`test/security.e2e.test.ts`) |
| 7.4.3       | Last-resort handler                       | Met    | `@Catch()` global filter                                                                                                                                                                                                                               |

## V8 Data protection

| #           | Requirement                                | Status  | Evidence / gap                                                                                                               |
| ----------- | ------------------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 8.1.1       | Sensitive responses not cached             | Met     | Every BFF response carries `Cache-Control: no-store` (`handlers.ts` `baseHeaders`); the API isn't reachable from the browser |
| 8.2.2       | No sensitive data in browser storage       | Met     | Cookies only (httpOnly); step-up in memory                                                                                   |
| 8.3.1       | Sensitive data in bodies/headers, not URLs | Met     | Credentials, TOTP and tokens are only in bodies or headers                                                                   |
| 8.3.4/6.2.x | Encryption of secrets at rest              | Met     | AES-256-GCM envelope encryption with AAD (`security/envelope.ts`, tamper tests); no KTrade credentials stored                |
| 8.3.x       | Backups protected                          | Partial | `backup.sh` encrypts only when `BACKUP_AGE_RECIPIENT` is set. **Rec:** make age encryption mandatory for off-host copies.    |
| 8.3.7       | Data at rest (DB volume)                   | Partial | Postgres volume isn't encrypted by the app. **Rec:** VPS disk encryption (host-level), documented in DEPLOYMENT_GUIDE.       |

## V9 Communications

| #           | Requirement                      | Status  | Evidence / gap                                                                                                                                                                                                                                                   |
| ----------- | -------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9.1.1       | TLS for all client traffic; HSTS | Met     | nginx :80 → 301 to HTTPS; HSTS 2 y (`infra/nginx/snippets/security-headers.conf`)                                                                                                                                                                                |
| 9.1.2/9.1.3 | TLS 1.2/1.3 only, strong ciphers | Met     | `infra/nginx/snippets/tls.conf` (Mozilla intermediate), verified in ADR-032                                                                                                                                                                                      |
| 9.2.2       | TLS for internal connections     | Not met | nginx → web → api and api → Postgres/Valkey are plaintext on Docker bridge networks on one host (`data` is `internal`). Accepted risk for a single host. **Rec:** if services ever span hosts, use TLS (`sslmode=verify-full`, `rediss://`) or a WireGuard mesh. |

## V10 Malicious code and supply chain

| #      | Requirement                                  | Status | Evidence / gap                                                                                                                                    |
| ------ | -------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10.3.2 | Dependency integrity                         | Met    | Committed lockfile, `--frozen-lockfile` in CI, `minimumReleaseAge: 10080` and `onlyBuiltDependencies` allow-list (`pnpm-workspace.yaml`, ADR-002) |
| 10.2.x | No back doors, phone-home or hidden features | Met    | KTrade automation adapters disabled behind a 4-flag chain; no outbound calls except configured providers                                          |
| 10.3.x | Secrets scanning                             | Met    | gitleaks job in `.github/workflows/ci.yml`; pre-commit scans                                                                                      |

## V12 Files and resources

| #           | Requirement                         | Status | Evidence / gap                                                                                                |
| ----------- | ----------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------- |
| 12.1.1      | Size limits                         | Met    | 2 MB import content (`imports/imports.schemas.ts`), 3 MB JSON in API and BFF, nginx `client_max_body_size 4m` |
| 12.3.1      | User file names never used as paths | Met    | Import content is stored as text in the DB; `fileName` regex rejects path characters                          |
| 12.4.x/12.5 | File storage, execution, serving    | N/A    | Nothing is written to disk; both containers run with a read-only filesystem                                   |

## V13 API

| #      | Requirement                         | Status  | Evidence / gap                                                                                                                                                                                                                                                       |
| ------ | ----------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 13.1.3 | No secrets in URLs                  | Met     | See 3.1.1                                                                                                                                                                                                                                                            |
| 13.1.4 | Authorization at every endpoint     | Met     | Global guard chain, default deny                                                                                                                                                                                                                                     |
| 13.2.1 | HTTP method allow-list              | Met     | CORS methods list; Nest routes are method-specific                                                                                                                                                                                                                   |
| 13.2.5 | Content-type enforced               | Partial | The BFF accepts JSON only (415). The API itself also accepts `application/x-www-form-urlencoded` (Nest's default parser). It isn't reachable from outside. **Rec:** create the app with `bodyParser: false` in `main.ts` and the e2e harness, registering JSON only. |
| 13.2.6 | CSRF for cookie-authenticated calls | Met     | See 4.2.2                                                                                                                                                                                                                                                            |

## V14 Configuration

| #             | Requirement                               | Status  | Evidence / gap                                                                                                                                                                                                                                                                          |
| ------------- | ----------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 14.1.x        | Hardened build and deploy                 | Met     | Non-root, read-only, `no-new-privileges`, `cap_drop: ALL`, internal `data` network, only nginx publishes ports (ADR-032)                                                                                                                                                                |
| 14.2.1/14.2.2 | Components up to date; no known vulns     | Partial | `pnpm audit`: **0 high/critical**, 3 moderate (see below). CI doesn't run `pnpm audit` yet. **Rec:** add `pnpm audit --prod --audit-level high` to CI.                                                                                                                                  |
| 14.3.2/14.3.3 | No debug or version disclosure in prod    | Met     | Swagger off, `NODE_ENV=production`, `server_tokens off`, `proxy_hide_header X-Powered-By`; API `x-powered-by` disabled (also on error paths now)                                                                                                                                        |
| 14.4.1–14.4.7 | Security headers                          | Partial | nosniff, HSTS, Referrer-Policy, frame-ancestors/XFO, COOP/CORP, Permissions-Policy all set. **CSP uses `'unsafe-inline'`** for scripts and styles (ADR-032). **Rec:** nonce-based CSP via `proxy.ts`.                                                                                   |
| 14.5.2        | Trusted proxy and origin headers          | Met     | **Fixed:** nginx overwrites `X-Real-IP`/`X-Forwarded-For`; the BFF trusts them only with `BFF_TRUST_PROXY=true`; the API trusts `X-Forwarded-For` only from `TRUST_PROXY_ADDRESSES` (validated; no hop counts or `/0`). The BFF Origin check ignores `X-Forwarded-Host` unless trusted. |
| 14.5.3        | CORS allow-list                           | Met     | `CORS_ORIGINS` exact list; evil-origin preflight gets no `Access-Control-Allow-Origin` (verified)                                                                                                                                                                                       |
| 14.3.1/14.1.3 | Env validated at boot, secrets out of git | Met     | `config/env.ts` (names only in errors); `.env.prod` gitignored, names-only template                                                                                                                                                                                                     |

## Finding 1 (fixed): client IP was the BFF container

Before this review the API saw the web container as the client of every request (ADR-032 follow-up 1). Throttling (5/min login) therefore became one global bucket shared by all clients, and audit/session `ip` was useless.

Design now:

1. **nginx** (internet edge): `X-Forwarded-For` and `X-Real-IP` are **overwritten** with `$remote_addr` (`infra/nginx/snippets/proxy-web.conf`). `$proxy_add_x_forwarded_for` is no longer used, because it appended to a client-supplied value.
2. **BFF** (`trustedClientIp` in `apps/web/src/lib/bff/handlers.ts`): only when `BFF_TRUST_PROXY=true` (prod compose; default off) does it read `X-Real-IP`, falling back to the right-most `X-Forwarded-For` entry. It validates the value with `net.isIP` and sends exactly one `X-Forwarded-For` hop to the API. The browser's own header is never copied (not in the forward allow-list).
3. **API** (`apps/api/src/bootstrap.ts`, `common/trust-proxy.ts`): Express `trust proxy` = `TRUST_PROXY_ADDRESSES`. The default is `loopback`; prod sets `loopback,172.30.250.10` (web's pinned address on the `app` network). Entries are validated at boot: only IPs, CIDRs (IPv4 ≥ /8, IPv6 ≥ /16) and the named ranges are allowed; `true`, hop counts and `/0` are rejected. `req.ip` feeds both the throttler tracker (default `getTracker`) and `@ReqMeta()` → audit `ip`.

Tests: `handlers.test.ts` covers trust off ignoring spoofed headers, exact `"true"` only, right-most hop, invalid IP dropped, and login and refresh forwarding. `test/security.e2e.test.ts` covers a trusted proxy giving per-forwarded-IP `req.ip`/audit IP and separate 429 buckets, an untrusted source with spoofed headers ignored and rotation not escaping the limit, and an empty list trusting nobody. `common/trust-proxy.test.ts` covers env validation.

Residual: the web container trusts nginx's header on the basis of network placement (only nginx and api can reach it). If a CDN or load balancer is ever added in front of nginx, configure `set_real_ip_from` for that provider's ranges.

## Dependency audit (2026-11-19)

`pnpm audit --prod` and `pnpm audit`: **no high or critical advisories**, so no version bumps were needed and the lockfile is unchanged.

| Advisory                       | Package (path)                                                | Reachable?                                               | Action                                                                         |
| ------------------------------ | ------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| GHSA-8cw4-87c7-c6xx (moderate) | csv-parse 6.2.1 (api, prod)                                   | Code path yes (OWNER-only import), exploit no: see 5.5.x | Fix only in 7.x (major). Recommend the upgrade + `Object.hasOwn` in the parser |
| GHSA-3g3m-2fjr-6pw4 (moderate) | glob 10.5.0 (testcontainers → archiver, dev)                  | No (test tooling only)                                   | Parent already at latest; wait for upstream                                    |
| GHSA-g3hv-75wg-m249 (moderate) | minimatch 9.0.9 / 10.2.6 (testcontainers, eslint, shadcn CLI) | No (dev/CLI only, patterns are not user input)           | Parents already at latest; wait for upstream                                   |

## Recommendations (TODO, by priority)

1. **3.3.2** Absolute session lifetime for refresh families (with an int test).
2. **4.3.1** Require TOTP enrolment for OWNER before LIVE trading or the kill switch can be enabled.
3. **14.2.1** `pnpm audit --prod --audit-level high` in CI; upgrade csv-parse to 7 (with parser tests) and harden `normaliseHeader` with `Object.hasOwn`.
4. **14.4** Nonce-based CSP (drop `'unsafe-inline'` for scripts).
5. **2.1.7** Offline breached-password list check.
6. **13.2.5** JSON-only body parsing in the API (`bodyParser: false` + JSON parser).
7. **8.3** Mandatory `age` encryption for off-host backups; host disk encryption.
8. **3.4.4** Consider `__Host-` cookie prefixes.
9. **2.2.3** Notify the owner on login from a new IP, 2FA changes and refresh-token reuse (needs a notification channel).
10. **9.2.2** TLS between services if the stack ever spans hosts.
