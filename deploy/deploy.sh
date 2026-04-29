#!/bin/bash
# Deploy Dittofeed + FIA Engagement Engine to VPS
# Usage: ./deploy.sh [VPS_IP] [SSH_USER]

set -euo pipefail

VPS_IP="${1:-77.42.40.0}"
SSH_USER="${2:-root}"
REMOTE_DIR="/opt/dittofeed"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "=== Deploying Dittofeed + FIA Engine to ${SSH_USER}@${VPS_IP} ==="

# Check if .env exists
if [ ! -f "${SCRIPT_DIR}/.env" ]; then
    echo "Error: .env file not found. Copy .env.example to .env and configure it."
    exit 1
fi

# Create remote directories
ssh "${SSH_USER}@${VPS_IP}" "mkdir -p ${REMOTE_DIR}/fia-engine"

# Copy deployment files
echo "Copying deployment files..."
scp "${SCRIPT_DIR}/docker-compose.yml" "${SSH_USER}@${VPS_IP}:${REMOTE_DIR}/"
scp "${SCRIPT_DIR}/.env" "${SSH_USER}@${VPS_IP}:${REMOTE_DIR}/"
scp "${SCRIPT_DIR}/nginx-dittofeed.conf" "${SSH_USER}@${VPS_IP}:/etc/nginx/sites-available/dittofeed" 2>/dev/null || true

# Copy FIA Engine source for building
echo "Copying FIA Engagement Engine..."
scp -r "${REPO_ROOT}/packages/fia-engagement-engine/src" "${SSH_USER}@${VPS_IP}:${REMOTE_DIR}/fia-engine/"
scp "${REPO_ROOT}/packages/fia-engagement-engine/package.json" "${SSH_USER}@${VPS_IP}:${REMOTE_DIR}/fia-engine/"
scp "${REPO_ROOT}/packages/fia-engagement-engine/tsconfig.json" "${SSH_USER}@${VPS_IP}:${REMOTE_DIR}/fia-engine/"
scp "${REPO_ROOT}/packages/fia-engagement-engine/tsconfig.build.json" "${SSH_USER}@${VPS_IP}:${REMOTE_DIR}/fia-engine/"
scp "${REPO_ROOT}/packages/fia-engagement-engine/Dockerfile" "${SSH_USER}@${VPS_IP}:${REMOTE_DIR}/fia-engine/"

# Build and start services
echo "Building and starting services..."
ssh "${SSH_USER}@${VPS_IP}" "cd ${REMOTE_DIR} && docker compose pull && docker compose build fia-engine && docker compose up -d"

# Enable nginx site if nginx is installed
ssh "${SSH_USER}@${VPS_IP}" "
  if command -v nginx &> /dev/null; then
    ln -sf /etc/nginx/sites-available/dittofeed /etc/nginx/sites-enabled/dittofeed 2>/dev/null || true
    nginx -t && systemctl reload nginx
    echo 'Nginx configured'
  fi
" 2>/dev/null || true

echo ""
echo "=== Deploy complete ==="
echo ""
echo "Services:"
echo "  Dittofeed:  https://ditto.axeljutoran.com"
echo "  FIA Engine: https://engine.axeljutoran.com"
echo "  Health:     https://engine.axeljutoran.com/health"
echo ""
echo "Logs:"
echo "  ssh ${SSH_USER}@${VPS_IP} 'cd ${REMOTE_DIR} && docker compose logs -f fia-engine'"
echo "  ssh ${SSH_USER}@${VPS_IP} 'cd ${REMOTE_DIR} && docker compose logs -f dittofeed-lite'"
