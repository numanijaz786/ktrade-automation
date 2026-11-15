# Deployment Guide

> **Status:** local development works today. Production packaging (one private HTTPS URL: nginx, web, api, Postgres and Valkey in Docker) is built and verified locally but **not deployed**. Deployment waits for hosting approval (USER_ACTION_REQUIRED #5).

## Local (development)

Prerequisites: Node 24 LTS, Docker, `corepack enable pnpm`.

```bash
pnpm install
pnpm db:up                                     # Postgres 16 + Valkey 8 on 127.0.0.1
cp .env.example apps/api/.env
pnpm --filter @ktrade/api keys:generate        # paste output into apps/api/.env (never commit)
cd apps/api
pnpm exec prisma generate
pnpm db:deploy                                 # migrations
cd ../.. && pnpm build
pnpm --filter @ktrade/api db:seed              # stocks + SIMULATED prices + KTrade fee schedule
pnpm --filter @ktrade/api start                # http://127.0.0.1:3001  (Swagger /api/docs)
pnpm --filter @ktrade/web dev                  # http://localhost:3000  (demo data client for now)
```

Then register the single owner account (`POST /api/v1/auth/register`). Registration closes after the first account.

## Production (packaged, not yet deployed)

Everything needed for one private HTTPS URL on a small VPS is in `infra/`. It has been verified locally with Docker (self-signed certificate). Nothing has been bought or deployed yet: that waits for your hosting approval (USER_ACTION_REQUIRED #5).

### What runs

| Service    | Built from                       | Reachable from                      | Notes                                                      |
| ---------- | -------------------------------- | ----------------------------------- | ---------------------------------------------------------- |
| `nginx`    | nginx:1.28-alpine                | **the internet, ports 80/443 only** | TLS 1.2/1.3, HSTS, CSP, rate limits, proxies only to `web` |
| `web`      | `infra/docker/web.Dockerfile`    | nginx (`edge`)                      | Next.js standalone + BFF, `NEXT_PUBLIC_DATA_MODE=api`      |
| `api`      | `infra/docker/api.Dockerfile`    | web only (`app`)                    | `HOST=0.0.0.0` inside its networks; nginx cannot reach it  |
| `migrate`  | api.Dockerfile, target `migrate` | none                                | one-shot `prisma migrate deploy`; `api` waits for it       |
| `postgres` | postgres:16-alpine               | api and migrate (`data`, internal)  | volume `pgdata`, never published                           |
| `valkey`   | valkey/valkey:8-alpine           | api (`data`, internal)              | AOF + noeviction (ADR-009), never published                |

Every container runs with `no-new-privileges`, restart `unless-stopped`, CPU and memory limits sized for 2 vCPU / 4 GB (about 3.2 GB in total) and log rotation (10 MB × 5 files). `api` and `web` run as the unprivileged `node` user on a read-only root filesystem.

Secrets live only in `infra/.env.prod` on the server (mode 600, gitignored; the template is `infra/.env.prod.example`). The images contain no secrets, and `web` and `nginx` get none at all.

### First deployment on a fresh Ubuntu 24.04 VPS

1. **Server basics** (as root):

   ```bash
   adduser ktrade && usermod -aG sudo ktrade        # then log in as ktrade with an SSH key
   sudo apt update && sudo apt -y upgrade && sudo apt -y install ufw unattended-upgrades git age
   sudo ufw default deny incoming && sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable
   # SSH key-only: in /etc/ssh/sshd_config set PasswordAuthentication no and PermitRootLogin no, then
   sudo systemctl restart ssh
   ```

   Docker-published ports bypass ufw, which is why only nginx publishes any.

2. **Docker Engine + Compose plugin** (official script; read it before running it):

   ```bash
   curl -fsSL https://get.docker.com -o get-docker.sh && less get-docker.sh
   sudo sh get-docker.sh && sudo usermod -aG docker ktrade && newgrp docker
   docker compose version                            # v2.24 or newer
   ```

3. **DNS:** create an `A` record (plus `AAAA` if the VPS has IPv6), for example `trade.example.com` pointing at the VPS IP. Wait until `dig +short trade.example.com` returns it.

4. **Code:** `sudo mkdir -p /opt/ktrade && sudo chown ktrade: /opt/ktrade && git clone <your repo> /opt/ktrade && cd /opt/ktrade`

5. **TLS certificate (Let's Encrypt).** It is issued under the fixed name `ktrade`, so nginx always reads `/etc/letsencrypt/live/ktrade/`, whatever the domain:

   ```bash
   sudo apt -y install certbot
   sudo certbot certonly --standalone --cert-name ktrade -d trade.example.com \
     --email you@example.com --agree-tos --no-eff-email \
     --pre-hook  "docker compose -f /opt/ktrade/infra/docker-compose.prod.yml stop nginx" \
     --post-hook "docker compose -f /opt/ktrade/infra/docker-compose.prod.yml start nginx"
   sudo certbot renew --dry-run                      # the hooks are saved and reused for renewals
   ```

   Renewals run from certbot's systemd timer and stop nginx for a few seconds.

6. **Secrets file:**

   ```bash
   cp infra/.env.prod.example infra/.env.prod && chmod 600 infra/.env.prod
   docker compose -f infra/docker-compose.prod.yml build
   docker compose -f infra/docker-compose.prod.yml run --rm --no-deps api node scripts/generate-keys.mjs
   openssl rand -hex 32                              # database password
   ```

   Fill in `infra/.env.prod` with a terminal editor (never paste the values into chats or tickets): `POSTGRES_PASSWORD`, `DATABASE_URL=postgresql://ktrade:<same password>@postgres:5432/ktrade`, the three key lines and `CORS_ORIGINS=https://trade.example.com`. Leave the schedulers `false` for now. **Keep an offline copy of `APP_MASTER_KEY`** (password manager): without it, encrypted data such as TOTP secrets can't be decrypted after a restore.

7. **Start:**

   ```bash
   docker compose -f infra/docker-compose.prod.yml up -d
   docker compose -f infra/docker-compose.prod.yml ps -a       # all healthy; migrate "Exited (0)"
   docker compose -f infra/docker-compose.prod.yml run --rm api node dist/seed/seed.js
   ```

8. **Register the owner straight away:** open `https://trade.example.com/register` and create the single OWNER account. Registration closes after the first account, so do it before anyone else can. Then enrol 2FA.

9. **Enable background jobs** when you want them: set `MARKET_DATA_TICKER`, `SNAPSHOT_SCHEDULER`, `ALERTS_SCHEDULER` and `STRATEGY_SCHEDULER` to `true` in `infra/.env.prod`, then run `docker compose -f infra/docker-compose.prod.yml up -d api` (recreates only the API).

10. **Optional owner-only access:** list your IPs in `infra/nginx/snippets/allowlist.conf`, then run `docker compose -f infra/docker-compose.prod.yml exec nginx nginx -s reload`. A VPN (WireGuard or Tailscale) is more reliable than home IPs, which change.

### Backups

`infra/scripts/backup.sh` runs `pg_dump` (custom format), gzips it, optionally encrypts it with `age`, writes `infra/backups/ktrade-<UTC>.dump.gz[.age]` and deletes dumps older than `BACKUP_RETENTION_DAYS` (default 14).

```bash
age-keygen -o ~/ktrade-backup.key     # on YOUR computer, not the server
# put the printed public key (age1...) into BACKUP_AGE_RECIPIENT in infra/.env.prod, then on the server:
sudo crontab -e
30 2 * * * /opt/ktrade/infra/scripts/backup.sh 2>&1 | logger -t ktrade-backup
```

Copy `infra/backups/` off the server too (rclone, restic or scp to another machine).

**Monthly restore test** (first Sunday of the month; record the date in the checklist). It restores into a scratch database and leaves the live one alone:

```bash
infra/scripts/restore.sh infra/backups/<latest file> ktrade_restore_test --identity ~/ktrade-backup.key
docker compose -f infra/docker-compose.prod.yml exec postgres psql -U ktrade -d ktrade_restore_test -c 'select count(*) from stocks'
docker compose -f infra/docker-compose.prod.yml exec postgres dropdb -U ktrade ktrade_restore_test
```

A real recovery (`restore.sh <file> ktrade --force`) needs `api` and `web` stopped first; the script header shows the steps.

### Updates and rollback

```bash
cd /opt/ktrade && infra/scripts/backup.sh                    # always back up first
git fetch && git log --oneline HEAD..origin/main             # review what will change
PREV=$(git rev-parse --short HEAD)                           # keep the running images under a tag
for i in api web migrate; do docker tag ktrade-$i:latest ktrade-$i:$PREV; done
git pull --ff-only
docker compose -f infra/docker-compose.prod.yml up -d --build   # migrate runs before the new api starts
docker image prune -f
```

**Rollback:** `git checkout $PREV`, then `IMAGE_TAG=$PREV docker compose -f infra/docker-compose.prod.yml up -d --no-build`. Migrations only go forward: if the bad release applied a migration the old code can't handle, restore the pre-update backup (`restore.sh <file> ktrade --force`) before starting the old version.

### Local production test (any machine with Docker)

```bash
infra/scripts/dev-selfsigned.sh            # → infra/certs/live/ktrade/ (gitignored); OPENSSL=/usr/bin/openssl in Git Bash
# create infra/.env.prod with throwaway values as in step 6, with CORS_ORIGINS=https://localhost
TLS_DIR=./certs docker compose -f infra/docker-compose.prod.yml -p ktrade-prodtest up -d --build
docker compose -f infra/docker-compose.prod.yml -p ktrade-prodtest run --rm api node dist/seed/seed.js
curl -k -i https://localhost/bff/auth/me    # 401 plus a Secure ktrade_csrf cookie
docker compose -f infra/docker-compose.prod.yml -p ktrade-prodtest down -v && rm -rf infra/certs infra/.env.prod
```

### Go-live checklist

Record the date and who checked each item.

- [ ] Hosting, domain and cost approved by the owner (nothing bought before that).
- [ ] VPS hardened: SSH key-only, root login off, ufw allows only 22/80/443, unattended-upgrades on.
- [ ] `docker compose ps -a`: every service healthy and `migrate` exited 0; only nginx has published ports.
- [ ] From another machine, `nmap -Pn -p 22,80,443,3000,3001,5432,6379 <host>` shows only 22, 80 and 443 open.
- [ ] `http://` redirects to `https://`; SSL Labs grade A or better; HSTS present (add `preload` later only if wanted).
- [ ] Security headers present (`curl -sI https://<domain>/login`): CSP, X-Content-Type-Options, Referrer-Policy, frame-ancestors, Permissions-Policy.
- [ ] Owner registered, `/register` refuses a second account, 2FA enrolled.
- [ ] Login works; cookies are `Secure; HttpOnly; SameSite=Strict`; no token in any response body.
- [ ] Secrets audit: `infra/.env.prod` is mode 600 and not in git; `APP_MASTER_KEY` stored offline; Swagger off.
- [ ] Backups: cron installed, an encrypted dump exists off the server, and a **restore test has succeeded**.
- [ ] `pnpm turbo run build typecheck lint test` (and the API integration suite) green on the deployed commit.
- [ ] Kill switch OFF, manual approval on, KTrade automation adapters disabled (CLAUDE.md non-negotiables).
- [ ] Optional: IP allow-list or VPN in front.

### Known limits

- The API's in-memory rate limiter sees every request as coming from the `web` container, because the BFF doesn't forward client IPs. nginx's per-IP limits on `/bff/auth/` are the effective brute-force guard; the API's account lockout still applies.
- The CSP needs `'unsafe-inline'` for scripts and styles (Next.js inline RSC payloads and next-themes, without nonces). Nonces would need a change in `apps/web/src/proxy.ts`.
- Valkey has no password; it is reachable only on the internal `data` network.
- One host and one API instance: no high availability. Keep the backups and the restore test going.

## Cost estimate (to be confirmed with you before any purchase)

| Item                | Monthly                                |
| ------------------- | -------------------------------------- |
| VPS (2 vCPU / 4 GB) | ~US$6–12                               |
| Domain              | ~US$1 (≈ US$10–15/year)                |
| TLS (Let's Encrypt) | free                                   |
| Market-data vendor  | vendor quote (USER_ACTION_REQUIRED #3) |
| LLM API (optional)  | usage-based                            |
