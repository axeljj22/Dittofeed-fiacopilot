# FIA Engagement Engine (Sofía) — Deploy to Hetzner VPS

## Architecture

```
Internet
  │
  └─ engine.axeljutoran.com ──→ Nginx :80/443 ──→ FIA Engine :3001
                                                    ├─ /health (healthcheck)
                                                    ├─ /webhook/whatsapp (incoming msgs)
                                                    ├─ /api/... (admin API)
                                                    └─ /api/trigger (manual run)

FIA Engine reads from:  Supabase (FIA Copilot DB) — profiles, capsules, progress, etc.
FIA Engine writes to:   Supabase — engagement_log, wa_conversation_*, engine_config, ...
External services:      Claude/Codex API, Evolution API (WhatsApp)
```

The engine is a fully standalone sidecar: it needs no local databases (no Postgres/ClickHouse/Temporal).

## Quick Start

### 1. Setup VPS (first time only)
```bash
ssh root@77.42.40.0 'bash -s' < setup.sh
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env with real values (Supabase, Claude API, WhatsApp/Evolution, etc.)
```

### 3. Deploy
```bash
chmod +x deploy.sh
./deploy.sh 77.42.40.0 root
```

### 4. Setup SSL (first time only)
```bash
ssh root@77.42.40.0 'certbot --nginx -d engine.axeljutoran.com --non-interactive --agree-tos -m tu@email.com'
```

### 5. Run Supabase migrations
Execute `packages/fia-engagement-engine/supabase/migrations/*.sql` in your Supabase SQL Editor.

### 6. DNS
```
A record: engine.axeljutoran.com → 77.42.40.0
```

## Services

| Service | URL | Description |
|---------|-----|-------------|
| FIA Engine Health | https://engine.axeljutoran.com/health | Engine healthcheck |
| WhatsApp Webhook | https://engine.axeljutoran.com/webhook/whatsapp | Incoming WA messages |
| Admin API | https://engine.axeljutoran.com/api/... | Stats, logs, config, triggers |

## Admin API

```bash
# Check engine health
curl https://engine.axeljutoran.com/health

# Manually trigger detectors (requires admin token)
curl -X POST https://engine.axeljutoran.com/api/trigger \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"detector": "all"}'
```

## Logs

```bash
# FIA Engine
ssh root@77.42.40.0 'cd /opt/dittofeed && docker compose logs -f fia-engine'
```

## CI/CD (GitHub Actions)

Add these secrets to your GitHub repo (Settings > Secrets):
- `VPS_HOST`: `77.42.40.0`
- `VPS_USER`: `root`
- `VPS_SSH_KEY`: Your private SSH key

Then any push to `main` that changes `deploy/` or `packages/fia-engagement-engine/` will auto-deploy
(see `.github/workflows/fia-engine-deploy.yaml`).
