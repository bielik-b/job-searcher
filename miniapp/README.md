# Job Searcher Favorites Mini App

Telegram Mini App for saved vacancies. It is designed for the Cloudflare free tier:

- Cloudflare Worker serves the UI and API.
- Cloudflare D1 stores per-user saved vacancies.
- Telegram `initData` is verified on every user API request.
- The bot syncs saved jobs through `/api/bot/favorites` when `FAVORITES_API_URL` and `FAVORITES_API_SECRET` are configured.

## Cloudflare Setup

1. Create a D1 database:

   ```bash
   npx wrangler d1 create job-searcher-favorites
   ```

2. Put the returned `database_id` into `miniapp/wrangler.toml`.

3. Add secrets:

   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put FAVORITES_API_SECRET
   ```

4. Deploy:

   ```bash
   cd miniapp
   npx wrangler deploy
   ```

5. In the main bot `.env`, set:

   ```dotenv
   TELEGRAM_WEBAPP_URL=https://job-searcher-favorites.bielik-job-searcher.workers.dev/
   FAVORITES_API_URL=https://job-searcher-favorites.bielik-job-searcher.workers.dev
   FAVORITES_API_SECRET=same-secret-as-worker
   ```

6. Restart the bot.

The Worker creates the D1 table automatically on first API request.
