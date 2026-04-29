# Dittofeed + FIA Engagement Engine — Deploy to Hetzner VPS

## Architecture

```
Internet
  │
  ├─ ditto.axeljutoran.com ──→ Nginx :80/443 ──→ Dittofeed Lite :3000
  │
  └─ engine.axeljutoran.com ──→ Nginx :80/443 ──→ FIA Engine :3001
                                                    ├─ /health (healthcheck)
                                                    ├─ /webhook/whatsapp (incoming msgs)
                                                    ├─ /api/engagement/stats (admin)
                                                    ├─ /api/engagement/logs (admin)
                                                    └─ /api/trigger (manual run)

FIA Engine reads from: Supabase (FIA Copilot DB)
FIA Engine writes to:  engagement_log table only
```

## Quick Start

### 1. Setup VPS (first time only)
```bash
ssh root@77.42.40.0 'bash -s' < setup.sh
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env with real values (Supabase, Claude API, WhatsApp, etc.)
```

### 3. Deploy
```bash
chmod +x deploy.sh
./deploy.sh 77.42.40.0 root
```

### 4. Setup SSL (first time only)
```bash
ssh root@77.42.40.0 'certbot --nginx -d ditto.axeljutoran.com -d engine.axeljutoran.com --non-interactive --agree-tos -m tu@email.com'
```

### 5. Run Supabase migration
Execute `packages/fia-engagement-engine/sql/001_engagement_log.sql` in your Supabase SQL Editor.

### 6. DNS
```
A record: ditto.axeljutoran.com  → 77.42.40.0
A record: engine.axeljutoran.com → 77.42.40.0
```

## Services

| Service | URL | Description |
|---------|-----|-------------|
| Dittofeed | https://ditto.axeljutoran.com | Journey orchestration dashboard |
| FIA Engine Health | https://engine.axeljutoran.com/health | Engine healthcheck |
| Engine Stats | https://engine.axeljutoran.com/api/engagement/stats | Engagement stats |
| Engine Logs | https://engine.axeljutoran.com/api/engagement/logs | Recent engagement logs |
| WhatsApp Webhook | https://engine.axeljutoran.com/webhook/whatsapp | Incoming WA messages |

## Admin API

```bash
# Check engine health
curl https://engine.axeljutoran.com/health

# Get engagement stats (last 7 days)
curl https://engine.axeljutoran.com/api/engagement/stats

# Get recent engagement logs
curl "https://engine.axeljutoran.com/api/engagement/logs?limit=50"

# Get logs for specific user
curl "https://engine.axeljutoran.com/api/engagement/logs?user_id=UUID"

# Manually trigger all detectors
curl -X POST https://engine.axeljutoran.com/api/trigger \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"detector": "all"}'

# Trigger only sponsor reports
curl -X POST https://engine.axeljutoran.com/api/trigger \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"detector": "sponsor"}'
```

## Logs

```bash
# All services
ssh root@77.42.40.0 'cd /opt/dittofeed && docker compose logs -f'

# FIA Engine only
ssh root@77.42.40.0 'cd /opt/dittofeed && docker compose logs -f fia-engine'

# Dittofeed only
ssh root@77.42.40.0 'cd /opt/dittofeed && docker compose logs -f dittofeed-lite'
```

## CI/CD (GitHub Actions)

Add these secrets to your GitHub repo (Settings > Secrets):
- `VPS_HOST`: `77.42.40.0`
- `VPS_USER`: `root`
- `VPS_SSH_KEY`: Your private SSH key

Then any push to `main` that changes `deploy/` or `packages/fia-engagement-engine/` will auto-deploy.
