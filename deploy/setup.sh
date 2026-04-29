#!/bin/bash
# Dittofeed + FIA Engine VPS Setup Script
# Run this on your Hetzner VPS (Ubuntu/Debian)
# Usage: ssh root@77.42.40.0 'bash -s' < setup.sh

set -euo pipefail

echo "=== Dittofeed + FIA Engine VPS Setup ==="

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

# Install Nginx if not present
if ! command -v nginx &> /dev/null; then
    echo "Installing Nginx..."
    apt-get install -y nginx
    systemctl enable nginx
    systemctl start nginx
fi

# Install Certbot for SSL
if ! command -v certbot &> /dev/null; then
    echo "Installing Certbot..."
    apt-get install -y certbot python3-certbot-nginx
fi

# Create app directory
mkdir -p /opt/dittofeed

# Setup firewall
if command -v ufw &> /dev/null; then
    echo "Configuring firewall..."
    ufw allow 22/tcp
    ufw allow 80/tcp
    ufw allow 443/tcp
    ufw --force enable
fi

echo ""
echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "1. Point DNS records:"
echo "   ditto.axeljutoran.com  → 77.42.40.0"
echo "   engine.axeljutoran.com → 77.42.40.0"
echo ""
echo "2. Copy files to VPS:"
echo "   Run: ./deploy.sh from your local machine"
echo ""
echo "3. Setup SSL:"
echo "   certbot --nginx -d ditto.axeljutoran.com -d engine.axeljutoran.com"
echo ""
echo "4. Run the FIA Copilot SQL migration:"
echo "   Execute sql/001_engagement_log.sql in your Supabase SQL Editor"
