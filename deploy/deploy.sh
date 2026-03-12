#!/bin/bash
# Deploy Dittofeed to VPS
# Usage: ./deploy.sh [VPS_IP] [SSH_USER]

set -euo pipefail

VPS_IP="${1:-77.42.40.0}"
SSH_USER="${2:-root}"
REMOTE_DIR="/opt/dittofeed"

echo "=== Deploying Dittofeed to ${SSH_USER}@${VPS_IP} ==="

# Check if .env exists
if [ ! -f "$(dirname "$0")/.env" ]; then
    echo "Error: .env file not found. Copy .env.example to .env and configure it."
    exit 1
fi

# Create remote directory
ssh "${SSH_USER}@${VPS_IP}" "mkdir -p ${REMOTE_DIR}"

# Copy files to VPS
echo "Copying files..."
scp "$(dirname "$0")/docker-compose.yml" "${SSH_USER}@${VPS_IP}:${REMOTE_DIR}/"
scp "$(dirname "$0")/.env" "${SSH_USER}@${VPS_IP}:${REMOTE_DIR}/"

# Pull latest images and restart
echo "Starting services..."
ssh "${SSH_USER}@${VPS_IP}" "cd ${REMOTE_DIR} && docker compose pull && docker compose up -d"

echo ""
echo "=== Deploy complete ==="
echo "Dittofeed is running at http://${VPS_IP}:3000"
echo "Check logs: ssh ${SSH_USER}@${VPS_IP} 'cd ${REMOTE_DIR} && docker compose logs -f'"
