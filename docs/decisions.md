# Decisions

Product decisions made so far, so they don't have to be asked again. The full spec is in [spec.md](spec.md).

## Product

- Build the real product, starting with Phase 1. No clickable prototype. (`prototype/index.html` is the original mockup, kept for reference.)
- Messenger first, then Instagram, website widget, WhatsApp and Telegram.
- The bot answers Messenger chats and page post comments by itself, using only the shop's knowledge base and catalog.
- Screen designs are approved before any UI is built.

## Orders and payments

- An order is **Confirmed** as soon as the customer confirms it in chat. The bot then asks for the delivery address and the payment method (`orders.checkout_step`).
- Payment methods: cash on delivery (delivery charge included in the total), bKash or Nagad. bKash and Nagad are paid to the shop's own number; the customer sends the transaction ID and shop staff verify it.
- The CRM tracks payment status: `unpaid`, `cod_due`, `pending_verification`, `paid`, `rejected`, `refunded`.

## Platform

- A separate super admin panel (`apps/admin`) on its own domain, with its own login.
- Plans and AI credits follow the demo plans in the spec; when credits run out the bot stops replying and messages still reach the inbox.

## Stack

- Next.js and Node.js, both TypeScript, in one pnpm monorepo.
- PostgreSQL with pgvector (no separate vector database), Redis with BullMQ for queues.
- AI: a cheap hosted model for now, behind the provider interface in `packages/ai`, so a free self-hosted model can replace it by changing env vars. Any OpenAI-compatible API works.
- Hosting: a Hostinger VPS with Docker Compose and Caddy for HTTPS; AWS later.
- Meta: Sharif's personal business account and app, in development mode, until App Review.
