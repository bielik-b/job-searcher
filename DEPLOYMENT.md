# Deployment

## Goal

Run the Telegram bot on external hosting so it does not depend on a laptop being on.

The project now supports two runtime modes:

- `npm run bot:start` - local polling mode for development.
- `npm run bot:webhook` - production webhook HTTP server for hosting.

## Runtime Endpoints

- `GET /health` returns `{"ok":true,"mode":"webhook"}`.
- `POST /telegram/webhook` accepts Telegram webhook updates.

## Required Environment Variables

Set these on the hosting provider:

```bash
BOT_MODE=webhook
PORT=3000
DATA_DIR=/data
SQLITE_PATH=/data/job-searcher.sqlite
PYTHON_BIN=python3
TELEGRAM_BOT_TOKEN=...
WEBHOOK_URL=https://<your-app-domain>/telegram/webhook
TELEGRAM_WEBHOOK_PATH=/telegram/webhook
TELEGRAM_WEBHOOK_SECRET=<random-secret>
TELEGRAM_WEBAPP_URL=https://job-searcher-favorites.bielik-job-searcher.workers.dev/
FAVORITES_API_URL=https://job-searcher-favorites.bielik-job-searcher.workers.dev
FAVORITES_API_SECRET=...
JOOBLE_API_KEY=...
LLM_PROVIDER=ollama
EXTERNAL_LLM_PROVIDER=google
GOOGLE_API_KEY=...
GOOGLE_MODEL=gemini-3.6-flash
```

Do not commit real secrets to git.

## Fly.io Deployment

This repo includes:

- `Dockerfile`
- `fly.toml`
- `.github/workflows/deploy-fly.yml`

### One-Time Fly Setup

1. Install and log in to Fly:

```bash
fly auth login
```

2. Create the app if it does not exist:

```bash
fly apps create bielik-job-searcher-bot
```

3. Create persistent storage for SQLite and uploaded resumes:

```bash
fly volumes create job_searcher_data --region fra --size 1
```

4. Set secrets:

```bash
fly secrets set TELEGRAM_BOT_TOKEN=...
fly secrets set TELEGRAM_WEBHOOK_SECRET=...
fly secrets set WEBHOOK_URL=https://bielik-job-searcher-bot.fly.dev/telegram/webhook
fly secrets set TELEGRAM_WEBAPP_URL=https://job-searcher-favorites.bielik-job-searcher.workers.dev/
fly secrets set FAVORITES_API_URL=https://job-searcher-favorites.bielik-job-searcher.workers.dev
fly secrets set FAVORITES_API_SECRET=...
fly secrets set JOOBLE_API_KEY=...
fly secrets set GOOGLE_API_KEY=...
```

5. Deploy:

```bash
fly deploy
```

6. Verify:

```bash
curl https://bielik-job-searcher-bot.fly.dev/health
fly logs
```

## GitHub Actions Deployment

For automatic deploys from GitHub:

1. Create a Fly token:

```bash
fly tokens create deploy -x 8760h
```

2. Add it to GitHub repo secrets as `FLY_API_TOKEN`.
3. Run the `Deploy Bot to Fly.io` workflow manually, or push to `main`.

## Important Notes

- The current production container uses SQLite on a persistent volume. Do not deploy without a volume, or user data and uploaded resumes can be lost.
- Webhook mode acknowledges Telegram updates quickly and processes them in the background to avoid duplicate retries.
- The local polling bot should be stopped after webhook hosting is verified, otherwise Telegram may report a polling/webhook conflict.
