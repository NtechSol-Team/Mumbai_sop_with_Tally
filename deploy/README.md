# Deploying Mumbai ERP

One server runs the whole stack via Docker Compose:

```
Internet ──▶ Caddy (:80/:443) ──▶ /            → web  (Next.js :3000)
                                 /api/*        → api  (Express :4000)
                                 /socket.io/*  → api  (websockets)
                                 /health       → api
Postgres 15 + volumes: pgdata, api_uploads (bill PDFs), caddy_data (TLS certs)
```

Single public origin = no CORS setup, and `NEXT_PUBLIC_API_URL` is simply that origin.

This app needs a **long-running process** — Socket.IO holds websockets, a dedicated
Postgres connection holds a `LISTEN`, pg-boss runs six workers (one on a 1-minute
cron), and bill PDFs are written to disk. That rules out serverless hosts (Vercel,
Netlify, Render's free tier): they sleep on idle and have no persistent disk.

## Choose a host

| | **Oracle Cloud Always Free** | **DigitalOcean droplet** |
|---|---|---|
| Cost | Free forever | ~$12–24/mo |
| Specs | 4 ARM cores / 24 GB / 200 GB | 2–4 GB RAM |
| Setup | `setup-oracle.sh` (§2a) | `setup-droplet.sh` (§2b) |
| Trade-off | Card needed to verify identity (not charged); ARM capacity is sometimes unavailable in a region | Paid, but provisions instantly |

Everything after §2 is identical for both — the stack is the same containers, and
all four images (postgres, caddy, api, web) build and run on arm64 as well as x86.


## 1. Create the server

Both hosts: **Ubuntu 24.04 LTS**, and the Next.js build is the memory peak, so
**2 GB RAM is the floor**.

**Oracle Cloud** — Compute → Instances → Create instance:
- Shape: **Ampere A1 Flex** (`VM.Standard.A1.Flex`), 2 OCPU / 12 GB is plenty
  (the free allowance is 4 OCPU / 24 GB total, so you can go higher at no cost)
- Image: Canonical Ubuntu 24.04 (**aarch64** build)
- Save the SSH keypair it offers — it is the only way in
- Every field must read "Always Free eligible" before you click Create

**DigitalOcean** — 2 GB droplet minimum, 4 GB comfortable. Ports 80/443 are open
by default; if you attach a Cloud Firewall, allow 22/80/443.

## 2a. Bootstrap an Oracle instance (one time)

SSH in as `ubuntu` and run:

```bash
BASE=https://raw.githubusercontent.com/NtechSol-Team/Mumbai_sop_with_Tally/main/deploy
curl -fsSO $BASE/setup-droplet.sh && curl -fsSO $BASE/setup-oracle.sh
bash setup-oracle.sh
```

`setup-oracle.sh` covers what a plain droplet does not — installs git (missing from
Oracle's minimal image), opens 80/443 in the host iptables (Oracle images end the
INPUT chain with a blanket REJECT) and persists them across reboot — then hands off
to `setup-droplet.sh` for the actual install.

**One step cannot be done from inside the VM.** Oracle also filters at the virtual
network layer, so add an ingress rule in the console:

> Networking → Virtual Cloud Networks → *your VCN* → Subnets → *your subnet*
> → Security Lists → Default Security List → **Add Ingress Rules**
> — source `0.0.0.0/0`, protocol TCP, destination ports **80** and **443**.

If the site does not load and `docker compose ps` shows everything healthy, this
rule is almost always the reason.

### Free HTTPS without buying a domain

Register a free subdomain at [duckdns.org](https://duckdns.org), point it at the
instance's public IP, then set both values in `deploy/.env` and run `deploy.sh` —
Caddy fetches a real Let's Encrypt certificate for it:

```ini
PUBLIC_ORIGIN=https://yourname.duckdns.org
SITE_ADDRESS=yourname.duckdns.org
```

Worth doing: Chrome's Web Bluetooth printing path only works on a secure origin.

## 2b. Bootstrap a DigitalOcean droplet (one time)

SSH in as root and run:

```bash
curl -fsSO https://raw.githubusercontent.com/<owner>/<repo>/main/deploy/setup-droplet.sh \
  && bash setup-droplet.sh
```

(Private repo? Just copy the script over: `scp deploy/setup-droplet.sh root@<ip>:` — it
will ask for the clone URL, where you can embed a GitHub PAT:
`https://<PAT>@github.com/<owner>/<repo>.git`.)

The script installs Docker, clones the repo to `/opt/mumbai-erp`, generates strong
secrets into `deploy/.env`, asks whether you have a domain (→ automatic HTTPS) or want
IP-only HTTP to start, builds, starts everything, and optionally seeds the database
(admin login from the seed script — change it immediately).

## 3. Updates

After pushing to `main` on GitHub:

```bash
ssh root@<droplet-ip> 'bash /opt/mumbai-erp/deploy/deploy.sh'
```

## 4. Moving from IP to a domain later

1. Point an A record (e.g. `erp.yourdomain.com`) at the droplet IP.
2. In `/opt/mumbai-erp/deploy/.env` set `PUBLIC_ORIGIN=https://erp.yourdomain.com` and
   `SITE_ADDRESS=erp.yourdomain.com`.
3. `bash /opt/mumbai-erp/deploy/deploy.sh` — Caddy fetches the Let's Encrypt certificate
   automatically; the web image rebuilds with the new origin baked in.

> HTTPS matters beyond cosmetics: Chrome's **Web Bluetooth** printing path (tablets
> without the Print Bridge app) only works on secure origins. The Print Bridge APK
> itself is fine with plain http.

## 5. Android tablets

Install the Mumbai ERP Print Bridge APK (see `apps/android-print-bridge/`), open it,
and enter the `PUBLIC_ORIGIN` address as the server URL.

## Useful commands (on the droplet)

```bash
cd /opt/mumbai-erp/deploy
docker compose -f docker-compose.prod.yml ps               # status
docker compose -f docker-compose.prod.yml logs -f api      # API logs
docker compose -f docker-compose.prod.yml exec postgres \
  pg_dump -U mumbai_erp mumbai_erp > /root/backup.sql       # DB backup
```
