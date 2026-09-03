#!/usr/bin/env bash
# One-time bootstrap for a fresh Ubuntu 22.04/24.04 DigitalOcean droplet.
# Run as root:  bash setup-droplet.sh
# (Recommended droplet size: 2 GB RAM minimum — the Next.js build needs it.)
set -euo pipefail

REPO_DIR=/opt/mumbai-erp

echo "── 1/5 Installing Docker (official convenience script) ─────────────────"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
else
  echo "Docker already installed: $(docker --version)"
fi

echo "── 2/5 Getting the code ────────────────────────────────────────────────"
if [ ! -d "$REPO_DIR/.git" ]; then
  read -rp "Git clone URL (for a private repo use https://<PAT>@github.com/owner/repo.git): " REPO_URL
  git clone "$REPO_URL" "$REPO_DIR"
else
  echo "Repo already present at $REPO_DIR — pulling latest."
  git -C "$REPO_DIR" pull --ff-only
fi
cd "$REPO_DIR/deploy"

echo "── 3/5 Configuration (deploy/.env) ─────────────────────────────────────"
if [ ! -f .env ]; then
  cp .env.example .env
  # Strong random secrets out of the box.
  sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 24)|" .env
  sed -i "s|^JWT_ACCESS_SECRET=.*|JWT_ACCESS_SECRET=$(openssl rand -hex 32)|" .env
  sed -i "s|^JWT_REFRESH_SECRET=.*|JWT_REFRESH_SECRET=$(openssl rand -hex 32)|" .env

  DROPLET_IP=$(curl -fsS ifconfig.me || hostname -I | awk '{print $1}')
  read -rp "Domain for HTTPS (blank = use http://$DROPLET_IP for now): " DOMAIN
  if [ -n "$DOMAIN" ]; then
    sed -i "s|^PUBLIC_ORIGIN=.*|PUBLIC_ORIGIN=https://$DOMAIN|" .env
    sed -i "s|^SITE_ADDRESS=.*|SITE_ADDRESS=$DOMAIN|" .env
  else
    sed -i "s|^PUBLIC_ORIGIN=.*|PUBLIC_ORIGIN=http://$DROPLET_IP|" .env
    sed -i "s|^SITE_ADDRESS=.*|SITE_ADDRESS=:80|" .env
  fi
  echo "Wrote deploy/.env — add Razorpay/GSTzen keys there whenever ready."
else
  echo "deploy/.env already exists — leaving it untouched."
fi

echo "── 4/5 Building & starting the stack (first build takes a few minutes) ─"
docker compose -f docker-compose.prod.yml up -d --build

echo "── 5/5 Database seed (first run only) ──────────────────────────────────"
read -rp "Seed sample data + admin login? Only for a brand-new database [y/N]: " SEED
if [[ "${SEED,,}" == "y" ]]; then
  docker compose -f docker-compose.prod.yml exec api npm run db:seed
  echo "Login: see the seed script output — change the password after first login."
fi

echo
echo "✔ Done. App: $(grep ^PUBLIC_ORIGIN= .env | cut -d= -f2)"
echo "  Health:  $(grep ^PUBLIC_ORIGIN= .env | cut -d= -f2)/health"
echo "  Logs:    docker compose -f $REPO_DIR/deploy/docker-compose.prod.yml logs -f"
echo "  Update:  bash $REPO_DIR/deploy/deploy.sh"
