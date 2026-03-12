#!/bin/bash
# Dittofeed VPS Setup Script
# Run this on your Hetzner VPS (Ubuntu/Debian)
# Usage: ssh root@77.42.40.0 'bash -s' < setup.sh

set -euo pipefail

echo "=== Dittofeed VPS Setup ==="

# Update system
apt-get update && apt-get upgrade -y

# Install Docker if not present
if ! command -v docker &> /dev/null; then
    echo "Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
fi

# Install Docker Compose plugin if not present
if ! docker compose version &> /dev/null; then
    echo "Installing Docker Compose plugin..."
    apt-get install -y docker-compose-plugin
fi

# Create app directory
mkdir -p /opt/dittofeed
cd /opt/dittofeed

echo "=== Docker installed successfully ==="
echo ""
echo "Next steps:"
echo "1. Copy docker-compose.yml and .env to /opt/dittofeed/"
echo "2. Edit .env with secure passwords"
echo "3. Run: cd /opt/dittofeed && docker compose up -d"
echo "4. Access Dittofeed at http://77.42.40.0:3000"
