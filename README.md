# FTR Fix Bot

Node.js server agent for:

- receiving job screenshots from a Telegram group
- OCR extraction of customer name, phone, account number, and address
- automatic BlueBubbles SMS/iMessage follow-up
- customer concern detection with Ollama/Qwen or Gemini
- manager escalation to Telegram
- mobile-first admin UI

## Local Run

```bash
cp .env.example .env
npm install
npm run pg:start
npm run db:migrate
npm run dev
```

Open `http://localhost:3000`.

## Prisma

Prisma is configured for schema management and future data-access work. The app still uses the existing raw `pg` queries for runtime behavior.

```bash
npm run db:generate
npm run db:migrate
npm run db:studio
```

`npm start` runs `prisma migrate deploy` before starting the server. Set `SKIP_PRISMA_MIGRATE=true` only if your deploy platform runs migrations separately.
If Prisma sees an existing non-empty database that was created before Prisma was added, startup baselines the initial migration by default. Set `PRISMA_BASELINE_EXISTING_DB=false` to disable that behavior.

## Coolify

Use the Dockerfile deployment type and attach:

- a Postgres database, exposed through `DATABASE_URL`
- a persistent volume mounted at `/app/data` for Telegram/OCR images and OCR support files
- environment variables from `.env.example`

Required production variables:

```text
NODE_ENV=production
PORT=3000
APP_BASE_URL=https://your-coolify-domain.example
DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DB
DATA_DIR=/app/data
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-this-password
SESSION_SECRET=change-this-long-random-secret-at-least-24-chars
TELEGRAM_BOT_TOKEN=replace-with-bot-token
BLUEBUBBLES_SERVER_URL=https://your-bluebubbles-server.example
BLUEBUBBLES_PASSWORD=replace-with-bluebubbles-password
BLUEBUBBLES_WEBHOOK_SECRET=change-this-webhook-secret
SKIP_PRISMA_MIGRATE=false
PRISMA_BASELINE_EXISTING_DB=true
```

The container has a `/healthz` healthcheck and listens on `PORT` or `3000`.

## Telegram Setup

Telegram bots cannot send to an invite link directly. Add the bot to both groups, then run:

- `/chatid` in any group to see its chat ID
- `/bind_jobs` in the job-image group
- `/bind_manager` in the manager-alert group

You can also set `TELEGRAM_JOB_CHAT_ID` and `TELEGRAM_MANAGER_CHAT_ID` in Coolify.
For private groups, `TELEGRAM_MANAGER_CHAT_ID` must be the numeric group ID, usually like `-1001234567890`.
The private invite link and group title are not valid send targets.

If the bot must see every image in a group, disable BotFather privacy mode or make sure the bot receives photo updates in that group.

## BlueBubbles Webhook

In the app, open Settings, set `App base URL` to your Coolify/proxy/tunnel domain, save, then copy the generated `BlueBubbles webhook URL`.

The URL format is:

```text
https://your-app-domain.example/webhooks/bluebubbles?secret=BLUEBUBBLES_WEBHOOK_SECRET
```

Enable at least the `new-message` event.

## Security

Do not commit real Telegram tokens, BlueBubbles passwords, Gemini keys, or admin passwords. Store them as Coolify environment variables. Rotate any credential that has been pasted into a chat or issue.
