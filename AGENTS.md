# Agents

This repository contains a single active package: **`packages/fia-engagement-engine`** — the FIA
Engagement Engine ("Sofía"), a standalone WhatsApp engagement sidecar for FIA Copilot. It reads/writes
the FIA Copilot Supabase, generates messages with Claude/Codex, and delivers them via the Evolution API.

The repo was forked from the open-source Dittofeed monorepo; all Dittofeed packages and infra have been
removed. The monorepo wrapper (`workspaces: ["packages/*"]`) is kept, but only the engine remains.

## Commands

```bash
# Install workspace deps (Yarn 4)
yarn install

# Type-check the engine (this is exactly what CI runs)
yarn workspace fia-engagement-engine check

# Build the engine (tsc → dist/)
yarn workspace fia-engagement-engine build

# Run locally (ts-node)
yarn workspace fia-engagement-engine dev
```

> Note: on Windows with an accented repo path, the `tsc` bin shim may fail to resolve. Build directly with
> `node node_modules/typescript/bin/tsc --build packages/fia-engagement-engine/tsconfig.build.json` if so.
> CI runs on Linux and is unaffected.

## Key Files and Directories

- `packages/fia-engagement-engine/src/config.ts`: environment variables and configuration.
- `packages/fia-engagement-engine/src/db/supabase.ts`: all Supabase reads/writes.
- `packages/fia-engagement-engine/CONVENTIONS.md`: deploy flow, VPS info, and code conventions.
- `packages/fia-engagement-engine/supabase/migrations/`: SQL migrations for the engine's own tables.
- `deploy/`: VPS deploy (docker-compose, nginx, setup/deploy scripts).
- `.github/workflows/fia-engine-deploy.yaml`: CI — type-check + deploy to the Hetzner VPS.
- `.tmp/`: disposable files for debugging.
