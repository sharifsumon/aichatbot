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
| `packages/commerce` | Order rules: confirm and reserve stock, delivery details, COD/bKash/Nagad, payment verification, cancel. |
| `packages/knowledge` | Knowledge base reading: PDF, XLSX, CSV, TXT, Q&A, website crawl, Google Sheets, and chunking for Bangla and English. |
| `packages/storage` | S3-compatible file storage (Cloudflare R2, MinIO, AWS S3). |
| `packages/ai` | The AI provider interface and an OpenAI-compatible implementation. |
| `packages/meta` | Meta webhook signature check, payload parsing and Graph API calls. |
| `packages/shared` | Env loading, secret encryption, queue names and job types. |

## How a Messenger message is answered

1. Meta posts the message to `POST /webhooks/meta`. The API checks the signature, queues one job per message with the message id as the job id (so Meta's retries are dropped), and returns 200 straight away.
2. The worker saves the message to the inbox (customer, conversation, message), and queues a reply job.
3. The reply job stays quiet if staff have taken over, the shop is suspended, the agent is not live, or the shop has no AI credits left. If a newer message arrived in the meantime, it lets that one answer.
4. Otherwise it finds matching products and knowledge, asks the model with the shop's rules, sends the reply through the Graph API, and records token usage and one credit.
5. In Messenger chat the model can also take an order with tools: once the customer confirms, `create_order` makes a Confirmed order and reserves stock; then it collects the address and delivery zone, the payment method, and for bKash or Nagad the transaction ID, which staff verify. Prices and totals always come from the catalog, never from the model.
6. If the model fails after retries, the customer gets "a team member will reply shortly" and the conversation switches to staff.

## How the knowledge base is built

Each knowledge source (file, text, Q&A, website, Google Sheet) is a job on the `knowledge` queue. The worker reads it, splits it into chunks (tables one row per line, Q&A one pair per chunk), embeds them, and swaps them in for the source's old chunks in one transaction. The source moves from queued to processing to ready, or to failed with a message the shop owner can act on ("Share the sheet as Anyone with the link"). Google Sheets are re-read every 6 hours. Website crawls stay on the same site, read at most 50 pages, and refuse private or internal addresses.

## Set up the Meta app (development mode)

In the Meta app's dashboard (developers.facebook.com):

1. Add **Facebook Login for Business** (or Facebook Login) and set the valid OAuth redirect URI to `${API_URL}/auth/facebook/callback`.
2. Add **Messenger**, and set the webhook callback URL to `${API_URL}/webhooks/meta` with `META_VERIFY_TOKEN` as the verify token. Subscribe to the `messages`, `messaging_postbacks` and `feed` fields.
3. Under App settings → Basic, set the data deletion callback URL to `${API_URL}/webhooks/meta/data-deletion` and the deauthorize callback URL to `${API_URL}/webhooks/meta/deauthorize`.
4. Copy the App ID and App Secret into `META_APP_ID` and `META_APP_SECRET`.

In development mode only people with a role on the app (admins, developers, testers) can sign in and only their pages can be connected. Other shops need App Review for the permissions in `packages/meta/src/oauth.ts`.

## Dashboard API

The API serves the dashboard at `/api` with a session cookie set by `/auth/facebook`. Changes must come from `WEB_URL` (checked by the Origin header), and someone who isn't a member of a workspace gets 404 for it.

| Route | What it does |
| --- | --- |
| `GET /auth/facebook` | Starts Facebook sign-in |
| `POST /auth/logout` | Ends the session |
| `GET /api/me` | The user and their workspaces |
| `POST /api/workspaces` | Creates a shop on the free trial, with an agent and the trial's AI credits |
| `GET /api/workspaces/:id/facebook/pages` | The user's pages, and which are connected |
| `POST /api/workspaces/:id/facebook/pages/:pageId/connect` | Connects a page: stores its token encrypted and subscribes the webhook |
| `POST /api/workspaces/:id/channels/:channelId/disconnect` | Unsubscribes and forgets the token |
| `GET /api/workspaces/:id/conversations` | Inbox: open conversations, newest first (`mode=ai\|human`, `status=closed`, `cursor`) |
| `GET /api/workspaces/:id/conversations/:cid` | One conversation with its messages (`before` for older ones) and whether a reply is still allowed |
| `POST …/conversations/:cid/takeover` · `return-to-ai` | Staff take over (the AI stops) or hand back |
| `POST …/conversations/:cid/reply` | Staff reply; takes the conversation over. Messenger only within 24 hours of the customer's last message |
| `GET /api/workspaces/:id/orders` | Orders CRM (`status`, `payment`, `q` for number, phone, name or transaction ID, `cursor`) |
| `GET /api/workspaces/:id/orders/summary` | Counts per order status and payment status |
| `GET /api/workspaces/:id/orders/:oid` | Order with items and customer |
| `POST …/orders/:oid/verify-payment` · `cancel` · `ship` · `deliver` · `return` | Staff actions; a rule violation answers 409 with a readable message |
| `GET /api/workspaces/:id/products` | Product Catalog (`status`, `q` for title or code, `cursor`); archived ones only with `status=archived` |
| `POST /api/workspaces/:id/products` · `GET` · `PUT` · `DELETE …/products/:pid` | Create, read, replace or archive a product with its colour × size stock grid. Cells are matched by colour and size, so edited cells keep their ids |
| `POST /api/workspaces/:id/uploads/images` | Product photo (JPEG, PNG or WebP, up to 5 MB, multipart `file`); returns the public URL |
| `GET /api/workspaces/:id/knowledge` | Knowledge sources with status and section count, and the plan's size usage |
| `POST /api/workspaces/:id/knowledge` | Adds a `text`, `qa`, `website` or `sheet` source and queues it for reading |
| `POST /api/workspaces/:id/knowledge/files` | Uploads a PDF, Excel, CSV or text file (up to 20 MB, multipart `file`) as a source |
| `GET` · `PATCH` · `DELETE …/knowledge/:sid`, `POST …/knowledge/:sid/resync` | Read, edit (text and Q&A), remove, or read again |
| `GET` · `PATCH /api/workspaces/:id/settings` | Shop name, language, delivery charges, bKash and Nagad numbers, COD. At least one way to pay must stay on |
| `POST /api/workspaces/:id/onboarding/complete` | Marks the setup checklist done |
| `GET` · `PATCH /api/workspaces/:id/agent` | The AI agent: name, tone, instructions, handoff rules, comment replies, and `status` (going `live` needs a connected page) |
| `GET /api/workspaces/:id/members` | Team members, pending invites, and seats used against the plan |
| `POST /api/workspaces/:id/invites` · `DELETE …/invites/:iid` | Creates an invite link (role `agent`, or `admin` by the owner; 7 days; shown once) or cancels it. 402 when every seat is taken |
| `GET /api/invites/:token` · `POST …/accept` | Shows what an invite is for, and joins the shop with it (signed in with Facebook) |
| `PATCH` · `DELETE /api/workspaces/:id/members/:uid` | Owner changes a role; owner or admin removes someone (admins only agents); anyone but the owner can leave |
| `POST /api/workspaces/:id/transfer-ownership` | Owner hands the shop to another member and becomes an admin |
| `GET /api/workspaces/:id/billing` | Plan, AI credits this month (with the 80% `low` and 100% `out` warning), usage against each limit, plans to compare |
| `GET /api/workspaces/:id/usage` | AI replies per day (`days`, up to 90) |

Uploads need object storage (`S3_*` in `.env`; product photos also need `S3_PUBLIC_URL`). Without it the upload routes answer 503 and everything else works.

**AI credits** are counted per calendar month (UTC). The worker gives every paying shop its plan's credits each month (an hourly job that never grants twice), notes "credits low" at 80% and "credits used up" at 100% in the activity feed once a month each, and the bot stops replying at 0 until a top-up or upgrade adds credits. Plan limits are checked when inviting staff (seats, the owner included), connecting a Facebook page, and adding to the knowledge base. Paying online (SSLCommerz, bKash, Stripe) is not built yet; until then the Agently team changes plans.

## Super admin API

The Agently team's API is served at `/admin` when `ADMIN_URL` is set. It is separate from the shop dashboard: its own users (`platform_users`), its own `agently_admin` cookie (path `/admin`, SameSite strict), and changes must come from `ADMIN_URL`. A shop session is never accepted.

**Sign-in** is an email and password, then a 6-digit code from an authenticator app (Google Authenticator, Authy, 1Password). The first sign-in returns a new secret (`otpauthUrl` for a QR code) and the first correct code confirms it. Five wrong passwords or codes lock the account for 15 minutes, and a code can't be used twice. Create the first super admin with:

```sh
ADMIN_EMAIL=you@example.com ADMIN_NAME="Your Name" pnpm admin:create   # prints a one-time password
```

**Roles:** super admin (everything), support (tenants and chats, no billing), finance (billing, no chats). Every view of a tenant or chat, every reveal of contact details, and every change is written to the audit log.

| Route | What it does | Who |
| --- | --- | --- |
| `POST /admin/auth/login` · `totp` · `logout` · `password`, `GET /admin/auth/me` | Sign in, two-factor, sign out, change password | Everyone |
| `GET /admin/overview` | Tenants by status, signups, today's messages, AI replies, handoffs, error rate, AI cost this month, MRR | All roles |
| `GET /admin/usage` | AI replies, tokens and cost per day and per model; top tenants; shops at 80% of their credits or more | All roles |
| `GET /admin/tenants` · `/tenants/:id` | All shops (`q`, `status`, `plan`, `cursor`) with owner, plan, pages, usage and last activity; one shop in full | All roles |
| `POST /admin/tenants/:id/suspend` · `reactivate` · `extend-trial` | Suspend (the bot stops; the owner sees the reason), reactivate, add trial days | Super admin, support |
| `POST /admin/tenants/:id/plan` · `credits` | Change plan (this month's credits topped up to the new plan), add or take back credits with a note | Super admin, finance |
| `GET /admin/conversations` · `/conversations/:id` | Every shop's chats (filter by tenant, mode, handed off, flagged, failed reply) with the AI's sources. Phones and addresses masked unless `reveal=true` | Super admin, support |
| `POST /admin/conversations/:id/reply` · `flag` | Reply as Agently support (labelled `support` in the shop's inbox; the AI stops), flag for review | Super admin, support |
| `GET` · `POST /admin/plans`, `PATCH /admin/plans/:id` | Plans and their limits | Read: all; edit: super admin, finance |
| `GET` · `POST /admin/team`, `PATCH /admin/team/:id` | The Agently team: add (one-time password), change role, disable, reset two-factor. One active super admin always remains | Super admin |
| `GET /admin/audit` | The audit log (`workspaceId`, `actorId`, `action`, `cursor`) | Super admin |
| `GET /admin/settings`, `PUT /admin/settings/:key`, `GET` · `PUT /admin/flags` | Default and fallback AI model, default instruction, top-up pack; feature flags globally, per plan or per shop | Super admin |

Not built yet: logging in as a tenant, invoices and payments (with the payment gateways), channel health and system pages (Phase 2).

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

Step by step for a Hostinger VPS, including the Meta app settings and a test shop: [docs/deploy-vps.md](docs/deploy-vps.md). Until the dashboard exists, `pnpm shop:connect` creates a shop and connects a Facebook page from a Graph API Explorer token (run it without `PAGE_ID` to list pages; `SAMPLE=1` adds a demo product and knowledge text).
