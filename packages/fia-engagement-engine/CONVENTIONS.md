# FIA Engagement Engine — Conventions

## VPS Info
- **IP:** `77.42.40.0`
- **SSH key:** `~/.ssh/julieta_vps`
- **Repo on VPS:** `/opt/dittofeed/repo/packages/fia-engagement-engine/`
- **Container name:** `fia-engine`
- **Port:** `3001` (mapped from container)
- **Public URL:** `https://engine.axeljutoran.com`
- **Sessions volume:** `/root/wa-sessions` → `/app/sessions`

---

## Deploy: update running code on VPS

### 1. Make changes locally in `packages/fia-engagement-engine/`

### 2. Sync changed files to VPS
```bash
# Sync entire src directory
scp -i ~/.ssh/julieta_vps -r \
  packages/fia-engagement-engine/src/ \
  root@77.42.40.0:/opt/dittofeed/repo/packages/fia-engagement-engine/

# If package.json changed (new dependency added)
scp -i ~/.ssh/julieta_vps \
  packages/fia-engagement-engine/package.json \
  root@77.42.40.0:/opt/dittofeed/repo/packages/fia-engagement-engine/

# If Dockerfile changed
scp -i ~/.ssh/julieta_vps \
  packages/fia-engagement-engine/Dockerfile \
  root@77.42.40.0:/opt/dittofeed/repo/packages/fia-engagement-engine/
```

### 3. Rebuild Docker image on VPS
```bash
ssh -i ~/.ssh/julieta_vps root@77.42.40.0 \
  "cd /opt/dittofeed/repo/packages/fia-engagement-engine && docker build -t fia-engine . 2>&1"
```

### 4. Restart container (preserves env vars and volumes from original run)
```bash
ssh -i ~/.ssh/julieta_vps root@77.42.40.0 "
docker stop fia-engine && docker rm fia-engine && \
docker run -d \
  --name fia-engine \
  --restart unless-stopped \
  -p 3001:3001 \
  -v /root/wa-sessions:/app/sessions \
  -v /root/.codex:/root/.codex \
  -e SUPABASE_URL=https://amqqqqubpsjtdufoinlg.supabase.co \
  -e SUPABASE_ANON_KEY=<anon_key> \
  -e SUPABASE_SERVICE_ROLE_KEY=<service_role_key> \
  -e ENGINE_BASE_URL=https://engine.axeljutoran.com \
  -e ENGINE_PORT=3001 \
  -e ADMIN_API_TOKEN=<token> \
  -e NODE_ENV=production \
  -e FIA_APP_BASE_URL=https://fiacopilot.com \
  -e PILOT_PHONE=5491125120212 \
  -e BYPASS_BUSINESS_HOURS=true \
  -e LOG_LEVEL=debug \
  fia-engine
"
```
> Full values are in the running container — retrieve with:
> `docker inspect fia-engine --format '{{range .Config.Env}}{{println .}}{{end}}'`

### 5. Verify startup
```bash
ssh -i ~/.ssh/julieta_vps root@77.42.40.0 "docker logs fia-engine --tail 20"
```
Look for: `FIA Engagement Engine HTTP server started` and `WhatsApp connected`.

---

## Dockerfile rules

- **No yarn.lock dependency.** The Dockerfile uses plain `yarn install` (no `--frozen-lockfile`).
- **Build tools** (`python3 make g++ git`) are in the builder stage for native modules.
- **Two-stage build:** builder compiles TypeScript → production image only copies `dist/` + `node_modules/`.

---

## Code conventions

### Adding a new journey
1. Add the journey name to `JourneyName` union in `src/db/types.ts`
2. Create detector in `src/detectors/<name>.ts` (copy structure from an existing one)
3. Export from `src/detectors/index.ts`
4. Add template + prompt in `src/generators/messageGenerator.ts`
5. Wire detector into `runSegmentDetectors()` in `src/orchestrator.ts`

### Adding a new response keyword
1. Add the type to `ResponseAction.type` union in `src/senders/responses.ts`
2. Add a new `if (normalized === "KEYWORD")` block in `classifyResponse()`
3. If the reply requires DB data, enrich in `processIncomingResponse()` after the classify call

### Sending a campaign message (manual outreach)
```bash
curl -X POST https://engine.axeljutoran.com/api/campaign/send \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ADMIN_API_TOKEN>" \
  -d '{
    "phone": "5491112345678",
    "message": "Hola...",
    "journeyName": "waitlist_outreach"
  }'
```
Rate limit: 4 sends/hour per IP.

### Running a full campaign
```bash
# From packages/fia-engagement-engine/
START_DATE=2026-03-24 \
ENGINE_URL=http://localhost:3001 \
ADMIN_API_TOKEN=<token> \
npx ts-node campaign/run.ts
```
- Skips sends more than 1 min in the past (prevents accidental re-sends on restart)
- Stays alive until the last scheduled send fires

---

## Logs
```bash
# Live logs
ssh -i ~/.ssh/julieta_vps root@77.42.40.0 "docker logs -f fia-engine"

# Last N lines
ssh -i ~/.ssh/julieta_vps root@77.42.40.0 "docker logs fia-engine --tail 50"
```

---

## Dashboard
`https://engine.axeljutoran.com/api/dashboard` — shows engagement_log, lead scores, WhatsApp status.
