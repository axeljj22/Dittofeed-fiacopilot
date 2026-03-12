# Dittofeed - Deploy to Hetzner VPS

## Quick Start

### 1. Deploy Dittofeed
```bash
chmod +x deploy.sh
./deploy.sh 77.42.40.0 root
```

### 2. Configure nginx (on VPS)
```bash
# Copy nginx config
scp nginx-dittofeed.conf root@77.42.40.0:/etc/nginx/sites-available/dittofeed

# Enable site and get SSL
ssh root@77.42.40.0 'ln -sf /etc/nginx/sites-available/dittofeed /etc/nginx/sites-enabled/ && nginx -t && systemctl reload nginx && certbot --nginx -d ditto.axeljutoran.com --non-interactive --agree-tos -m tu@email.com'
```

### 3. DNS (already configured)
A record: `ditto` → `77.42.40.0`

### 4. Access
https://ditto.axeljutoran.com

## CI/CD (GitHub Actions)

Add these secrets to your GitHub repo (Settings > Secrets):
- `VPS_HOST`: `77.42.40.0`
- `VPS_USER`: `root`
- `VPS_SSH_KEY`: Your private SSH key

Then any push to `main` that changes `deploy/` will auto-deploy.
