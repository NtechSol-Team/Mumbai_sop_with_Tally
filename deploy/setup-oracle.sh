#!/usr/bin/env bash
# One-time bootstrap for a fresh Oracle Cloud "Always Free" Ampere A1 instance
# (Ubuntu 22.04/24.04, arm64). Run as the default `ubuntu` user:
#
#   bash setup-oracle.sh
#
# Oracle's free ARM shape (up to 4 OCPU / 24 GB RAM / 200 GB disk) runs this
# whole stack comfortably — the Next.js build is the peak and has plenty of room.
#
# This wrapper only handles what differs from a plain droplet, then hands off to
# setup-droplet.sh for the actual install:
#   1. login user is `ubuntu`, not root          → sudo
#   2. minimal image, no git                     → apt install
#   3. host iptables rejects everything but SSH  → open 80/443 and persist
#
# NOTE: opening the host firewall is only half the job. Oracle also filters at
# the virtual network level, and that part CANNOT be done from inside the VM —
# see the reminder printed at the end.
set -euo pipefail

SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"

echo "── Oracle 1/3 Prerequisites ────────────────────────────────────────────"
export DEBIAN_FRONTEND=noninteractive
$SUDO apt-get update -qq
# git: not in the minimal image. iptables-persistent: survives reboots.
$SUDO apt-get install -y -qq git curl ca-certificates iptables-persistent

echo "── Oracle 2/3 Host firewall (ports 80/443) ─────────────────────────────"
# Oracle's images end the INPUT chain with a blanket REJECT, so the ACCEPTs are
# inserted at the top (-I INPUT 1) rather than appended after it. `-C` first so
# re-running this script doesn't stack duplicate rules.
for PORT in 80 443; do
  if $SUDO iptables -C INPUT -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null; then
    echo "  port $PORT already open"
  else
    $SUDO iptables -I INPUT 1 -p tcp --dport "$PORT" -j ACCEPT
    echo "  opened port $PORT"
  fi
done
$SUDO netfilter-persistent save >/dev/null
echo "  rules saved (persist across reboot)"

echo "── Oracle 3/3 Handing off to the standard installer ────────────────────"
# Docker needs the login user in its group; takes effect in the next shell, so
# the handoff below still runs docker through sudo.
$SUDO usermod -aG docker "$USER" 2>/dev/null || true

cd "$(dirname "$0")"
if [ ! -f setup-droplet.sh ]; then
  echo "ERROR: setup-droplet.sh must sit next to this script. Download both:" >&2
  echo "  curl -fsSO https://raw.githubusercontent.com/NtechSol-Team/Mumbai_sop_with_Tally/main/deploy/setup-droplet.sh" >&2
  echo "  curl -fsSO https://raw.githubusercontent.com/NtechSol-Team/Mumbai_sop_with_Tally/main/deploy/setup-oracle.sh" >&2
  exit 1
fi
$SUDO bash setup-droplet.sh

cat <<'REMINDER'

────────────────────────────────────────────────────────────────────────────
If the site does not load, the VCN is still blocking it. Oracle filters
traffic BEFORE it reaches the VM, and that rule cannot be added from in here:

  Oracle Cloud console
    → Networking → Virtual Cloud Networks → (your VCN)
    → Subnets → (your subnet) → Security Lists → Default Security List
    → Add Ingress Rules:

        Source CIDR   IP Protocol   Destination Port
        0.0.0.0/0     TCP           80
        0.0.0.0/0     TCP           443

Free HTTPS without buying a domain: register a name at https://duckdns.org,
point it at this instance's public IP, then set both of these in deploy/.env
and re-run deploy.sh — Caddy will fetch a real Let's Encrypt certificate.

    PUBLIC_ORIGIN=https://yourname.duckdns.org
    SITE_ADDRESS=yourname.duckdns.org
────────────────────────────────────────────────────────────────────────────
REMINDER
