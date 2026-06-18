# FIA Engagement Engine (Sofía)

Standalone WhatsApp engagement sidecar for **FIA Copilot**. It detects engagement opportunities, generates
messages with Claude/Codex, and delivers them over WhatsApp (Evolution API), reading and writing the FIA
Copilot Supabase database.

This repository was forked from the open-source [Dittofeed](https://dittofeed.com) monorepo; all Dittofeed
code and infrastructure have since been removed. The only active package is
[`packages/fia-engagement-engine`](packages/fia-engagement-engine).

## Structure

```
packages/fia-engagement-engine/   # The engine (Sofía) — see its CONVENTIONS.md
deploy/                           # VPS deploy: docker-compose, nginx, scripts
.github/workflows/                # CI: fia-engine-deploy.yaml (type-check + deploy)
```

## Getting started

```bash
yarn install
yarn workspace fia-engagement-engine check   # type-check
yarn workspace fia-engagement-engine dev      # run locally
```

See [AGENTS.md](AGENTS.md) for the working conventions and
[`packages/fia-engagement-engine/CONVENTIONS.md`](packages/fia-engagement-engine/CONVENTIONS.md) for the
deploy flow and VPS details.
