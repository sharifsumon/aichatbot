# Agently

An AI sales and support agent for Facebook-first shops in Bangladesh. A shop trains it on its products and content, and it answers customers on Messenger and post comments, takes orders, and hands off to staff.

- Product spec: [docs/spec.md](docs/spec.md)
- Decisions so far: [docs/decisions.md](docs/decisions.md)

## Layout

| Path | What it is |
| --- | --- |
| `apps/web` | Shop dashboard (Next.js). Placeholder until the screen designs are approved. |
| `apps/admin` | Super admin panel (Next.js), on its own domain. Placeholder for now. |
| `apps/api` | HTTP API (Fastify): health check and the Meta webhook. |
| `apps/worker` | Background jobs (BullMQ): saves incoming messages, writes and sends AI replies. |
| `packages/db` | Database schema and migrations (Drizzle, Postgres + pgvector). |
| `packages/ai` | The AI provider interface and an OpenAI-compatible implementation. |
| `packages/meta` | Meta webhook signature check, payload parsing and Graph API calls. |
| `packages/shared` | Env loading, secret encryption, queue names and job types. |

## How a Messenger message is answered

1. Meta posts the message to `POST /webhooks/meta`. The API checks the signature, queues one job per message with the message id as the job id (so Meta's retries are dropped), and returns 200 straight away.
2. The worker saves the message to the inbox (customer, conversation, message), and queues a reply job.
3. The reply job stays quiet if staff have taken over, the shop is suspended, the agent is not live, or the shop has no AI credits left. If a newer message arrived in the meantime, it lets that one answer.
4. Otherwise it finds matching products and knowledge, asks the model with the shop's rules, sends the reply through the Graph API, and records token usage and one credit.
5. If the model fails after retries, the customer gets "a team member will reply shortly" and the conversation switches to staff.

## Run it locally

Needs Node 22, pnpm 10 and Docker.

```sh
cp .env.example .env          # then fill in ENCRYPTION_KEY, Meta and AI values
pnpm install
pnpm infra:up                 # Postgres (with pgvector) and Redis
pnpm db:migrate && pnpm db:seed
pnpm dev                      # web :3000, admin :3001, api :4000, worker
```

To receive real Messenger webhooks locally, expose the API with a tunnel (for example `cloudflared tunnel --url http://localhost:4000`) and set `https://<tunnel>/webhooks/meta` as the callback URL in the Meta app, with `META_VERIFY_TOKEN` as the verify token.

Checks: `pnpm typecheck`, `pnpm build`, `pnpm test`. The worker tests run the whole message pipeline against a real database when `DATABASE_URL` is set, and skip otherwise.

After changing the schema in `packages/db/src/schema`, run `pnpm db:generate` and commit the new migration.

## Deploy to a VPS

On the server, with Docker installed and three domains pointing at it:

```sh
cp .env.example .env          # production values, a strong POSTGRES_PASSWORD, and the three *_DOMAIN values
docker compose --profile app up -d --build
```

This runs migrations, then starts the API, worker, web, admin and Caddy, which gets HTTPS certificates automatically. Postgres and Redis listen only on localhost.
