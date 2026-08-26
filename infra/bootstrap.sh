#!/usr/bin/env bash
#
# Idempotent droplet provisioning for the social media monitor.
#
# Safe to run on every deploy: each step checks for the thing it would create
# and does nothing if it is already there. That means a rebuilt droplet needs no
# remembered manual steps, and a healthy one is untouched.
#
# This droplet is SHARED with matchpoint-academy. Everything here is namespaced
# so the two never collide:
#   - matchpoint runs node on :3000, this app on :3100
#   - matchpoint owns nginx's port 80/443 default_server, this app owns :8080
#   - separate service users, separate app roots, separate nginx config files
#
# Crucially, matchpoint's own CI rewrites /etc/nginx/sites-available/matchpoint
# on every one of its deploys. Nothing here may live in that file, or the next
# matchpoint deploy would silently delete it.

set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/social-media-monitor}"
SERVICE_USER="${SERVICE_USER:-smmonitor}"
PUBLIC_PORT="${PUBLIC_PORT:-8080}"

echo "==> Bootstrapping ${APP_ROOT} (user: ${SERVICE_USER}, port: ${PUBLIC_PORT})"

# --- Node -------------------------------------------------------------------
# The box already has Node 20 from the matchpoint bootstrap. This block only
# does work on a freshly rebuilt droplet.
if ! command -v node >/dev/null 2>&1; then
  echo "==> Installing Node 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  echo "==> Node already present: $(node --version)"
fi

# --- nginx ------------------------------------------------------------------
if ! command -v nginx >/dev/null 2>&1; then
  echo "==> Installing nginx"
  apt-get update -qq
  apt-get install -y nginx
else
  echo "==> nginx already present: $(nginx -v 2>&1)"
fi

# --- Service user -----------------------------------------------------------
# A system account with no login shell and no home: it exists only to own the
# files and run the process, so a compromise of the app is not a shell.
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  echo "==> Creating service user ${SERVICE_USER}"
  useradd --system --no-create-home --shell /usr/sbin/nologin "${SERVICE_USER}"
else
  echo "==> Service user ${SERVICE_USER} already exists"
fi

# --- Directories ------------------------------------------------------------
# data/ is created here rather than by the app because the systemd unit runs
# with ProtectSystem=strict: the process may write inside data/ but may not
# create it.
mkdir -p "${APP_ROOT}/data"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${APP_ROOT}"

# nginx serves the dashboard's static files straight off disk, so its worker
# (www-data) needs to traverse into the app root and read index.html, css/, js/.
# Group-readable, not world-readable: .env lands in this directory too and is
# separately locked to 600 by the deploy.
chmod 755 "${APP_ROOT}"

# --- Firewall ---------------------------------------------------------------
# ufw is active on this box with only 22/80/443 open, so the dashboard's port
# has to be opened explicitly or nginx would listen into a closed door.
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
  if ! ufw status | grep -qE "^${PUBLIC_PORT}/tcp"; then
    echo "==> Opening port ${PUBLIC_PORT}/tcp"
    ufw allow "${PUBLIC_PORT}/tcp" comment 'social media monitor dashboard'
  else
    echo "==> Port ${PUBLIC_PORT}/tcp already open"
  fi
fi

echo "==> Bootstrap complete"
