/**
 * Runs the inbound → reply pipeline against a real Postgres with fake AI and
 * Meta clients. Needs DATABASE_URL pointing at a migrated database; skipped otherwise.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import type { AIProvider, ChatRequest } from '@agently/ai';
import { AIProviderError } from '@agently/ai';
import {
  EMBEDDING_DIMENSIONS,
  agents,
  channels,
  conversations,
  createDb,
  creditGrants,
  messages,
  orders,
  productVariants,
  products,
  usageRecords,
  workspaces,
  type Db,
} from '@agently/db';
import { encryptSecret, type InboundJob, type ReplyJob } from '@agently/shared';
import type { WorkerDeps } from './deps.ts';
import { handleInbound } from './inbound.ts';
import { handleReply } from './reply.ts';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL not set';
const key = randomBytes(32).toString('base64');

let db: Db;
let close: () => Promise<void>;
let sent: { psid: string; text: string }[];
let prompts: ChatRequest[];
let queued: ReplyJob[];
let aiImpl: AIProvider['chat'];

function deps(): WorkerDeps {
  return {
    db,
    log: pino({ level: 'silent' }),
    encryptionKey: key,
    pricing: { inputPerMTok: 1, outputPerMTok: 2 },
    ai: {
      chatModel: 'fake',
      chat: (req) => aiImpl(req),
      embed: async (texts) => texts.map(() => Array(EMBEDDING_DIMENSIONS).fill(0.01)),
    },
    graph: {
      sendText: async (_token, psid, text) => {
        sent.push({ psid, text });
        return [`mid-out-${sent.length}`];
      },
      replyToComment: async () => 'c-out',
      privateReply: async () => 'p-out',
    },
    enqueueReply: async (job) => {
      queued.push(job);
    },
  };
}

async function makeShop(pageId: string) {
  const [ws] = await db.insert(workspaces).values({ name: `Shop ${pageId}`, status: 'active', bkashNumber: '01811111111' }).returning();
  const [agent] = await db.insert(agents).values({ workspaceId: ws!.id, name: 'Mina', status: 'live' }).returning();
  await db.insert(channels).values({
    workspaceId: ws!.id,
    agentId: agent!.id,
    type: 'facebook_page',
    externalId: pageId,
    name: 'Page',
    accessTokenEncrypted: encryptSecret('page-token', key),
  });
  await db.insert(creditGrants).values({ workspaceId: ws!.id, reason: 'plan', credits: 10, expiresAt: new Date(Date.now() + 864e5) });
  const [product] = await db.insert(products).values({ workspaceId: ws!.id, title: 'Cotton Shirt', code: 'SH-01', price: '850' }).returning();
  await db.insert(productVariants).values({ workspaceId: ws!.id, productId: product!.id, color: 'Blue', size: 'L', stock: 3 });
  return ws!;
}

const inbound = (pageId: string, mid: string, text: string, ts = Date.now()): InboundJob => ({
  channel: 'facebook_page',
  channelExternalId: pageId,
  senderExternalId: `psid-${pageId}`,
  externalId: mid,
  kind: 'message',
  text,
  attachments: [],
  timestamp: ts,
});

before(async () => {
  if (skip) return;
  ({ db, close } = createDb(url!, { max: 4 }));
});
after(async () => {
  if (!skip) await close();
});
beforeEach(() => {
  sent = [];
  prompts = [];
  queued = [];
  aiImpl = async (req) => {
    prompts.push(req);
    return { text: 'Cotton Shirt ৳850, Blue L in stock.', toolCalls: [], usage: { inputTokens: 100, outputTokens: 20 }, model: 'fake' };
  };
});

test('saves a message once, replies from the catalog and charges one credit', { skip }, async () => {
  const page = `page-${randomBytes(4).toString('hex')}`;
  const ws = await makeShop(page);

  assert.equal(await handleInbound(deps(), inbound(page, `${page}-m1`, 'shirt er dam koto?')), 'saved');
  assert.equal(await handleInbound(deps(), inbound(page, `${page}-m1`, 'shirt er dam koto?')), 'duplicate');
  assert.equal(queued.length, 1);

  assert.equal(await handleReply(deps(), queued[0]!, { finalAttempt: false }), 'sent');
  assert.deepEqual(sent, [{ psid: `psid-${page}`, text: 'Cotton Shirt ৳850, Blue L in stock.' }]);

  const system = prompts[0]!.messages[0]!.content;
  assert.match(system, /Cotton Shirt \[code SH-01\] ৳ 850/);
  assert.match(system, /Banglish/);

  // A retried reply job must not answer twice.
  assert.equal(await handleReply(deps(), queued[0]!, { finalAttempt: false }), 'skipped_already_replied');

  const [usage] = await db.select().from(usageRecords).where(eq(usageRecords.workspaceId, ws.id));
  assert.equal(usage!.aiReplies, 1);
  assert.equal(usage!.inputTokens, 100);
});

test('stays quiet in human mode and only answers the latest of a burst', { skip }, async () => {
  const page = `page-${randomBytes(4).toString('hex')}`;
  await makeShop(page);
  const t = Date.now();
  await handleInbound(deps(), inbound(page, `${page}-a`, 'hi', t));
  await handleInbound(deps(), inbound(page, `${page}-b`, 'price?', t + 1));

  assert.equal(await handleReply(deps(), queued[0]!, { finalAttempt: false }), 'skipped_newer_message');
  const [msg] = await db.select().from(messages).where(eq(messages.id, queued[1]!.messageId));
  await db.update(conversations).set({ mode: 'human' }).where(eq(conversations.id, msg!.conversationId));
  assert.equal(await handleReply(deps(), queued[1]!, { finalAttempt: false }), 'skipped_human_mode');
  assert.equal(sent.length, 0);
});

test('goes quiet with no credits, and falls back to staff when the AI fails', { skip }, async () => {
  const page = `page-${randomBytes(4).toString('hex')}`;
  const ws = await makeShop(page);
  await handleInbound(deps(), inbound(page, `${page}-x`, 'এই শার্টের দাম কত?'));

  aiImpl = async () => {
    throw new AIProviderError('down', 503, true);
  };
  await assert.rejects(handleReply(deps(), queued[0]!, { finalAttempt: false }));
  assert.equal(await handleReply(deps(), queued[0]!, { finalAttempt: true }), 'fallback');
  assert.equal(sent[0]!.text, 'ধন্যবাদ! আমাদের একজন প্রতিনিধি শীঘ্রই আপনাকে উত্তর দেবেন।');
  const [msg] = await db.select().from(messages).where(eq(messages.id, queued[0]!.messageId));
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, msg!.conversationId));
  assert.equal(conv!.mode, 'human');

  await db.delete(creditGrants).where(eq(creditGrants.workspaceId, ws.id));
  await handleInbound(deps(), inbound(page, `${page}-y`, 'hello'));
  await db.update(conversations).set({ mode: 'ai' }).where(eq(conversations.id, conv!.id));
  assert.equal(await handleReply(deps(), queued[1]!, { finalAttempt: false }), 'skipped_no_credits');
});

test('a message for one shop never reaches another shop', { skip }, async () => {
  const pageA = `page-${randomBytes(4).toString('hex')}`;
  const pageB = `page-${randomBytes(4).toString('hex')}`;
  const a = await makeShop(pageA);
  const b = await makeShop(pageB);
  await handleInbound(deps(), inbound(pageA, `${pageA}-1`, 'hi'));
  const rows = await db.select().from(messages).where(eq(messages.externalId, `${pageA}-1`));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.workspaceId, a.id);

  // A reply job naming the wrong workspace finds nothing.
  assert.equal(await handleReply(deps(), { workspaceId: b.id, messageId: rows[0]!.id }, { finalAttempt: true }), 'skipped_missing');
});

test('takes a bKash order through chat with tools', { skip }, async () => {
  const page = `page-${randomBytes(4).toString('hex')}`;
  const ws = await makeShop(page);

  // A scripted model: each customer turn calls one tool, then answers.
  const script: Record<string, { name: string; arguments: Record<string, unknown> }> = {
    'yes confirm': { name: 'create_order', arguments: { items: [{ code: 'sh-01', color: 'blue', size: 'L', quantity: 2 }] } },
    'Rahim 01712345678 House 5 Road 2 Dhanmondi': {
      name: 'set_delivery_details',
      arguments: { order_number: 1001, customer_name: 'Rahim', phone: '01712345678', address: 'House 5, Road 2, Dhanmondi', zone: 'inside_dhaka' },
    },
    bkash: { name: 'set_payment_method', arguments: { order_number: 1001, method: 'bkash' } },
    'TrxID 9AB3XK2LQ1': { name: 'submit_transaction_id', arguments: { order_number: 1001, transaction_id: '9AB3XK2LQ1' } },
  };
  const toolResults: string[] = [];
  aiImpl = async (req) => {
    prompts.push(req);
    const last = req.messages.at(-1)!;
    if (last.role === 'tool') {
      toolResults.push(last.content);
      return { text: 'ok', toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, model: 'fake' };
    }
    const call = script[last.content];
    return { text: '', toolCalls: call ? [{ id: 'c1', ...call }] : [], usage: { inputTokens: 10, outputTokens: 5 }, model: 'fake' };
  };

  for (const [i, text] of Object.keys(script).entries()) {
    await handleInbound(deps(), inbound(page, `${page}-${i}`, text, Date.now()));
    assert.equal(await handleReply(deps(), queued.at(-1)!, { finalAttempt: false }), 'sent');
  }

  assert.equal(toolResults.length, 4);
  assert.ok(toolResults.every((r) => !r.includes('"error"')), toolResults.join('\n'));
  assert.match(toolResults[2]!, /01811111111/);

  const [order] = await db.select().from(orders).where(eq(orders.workspaceId, ws.id));
  assert.equal(order!.status, 'confirmed');
  assert.equal(order!.total, '1760.00');
  assert.equal(order!.paymentMethod, 'bkash');
  assert.equal(order!.paymentStatus, 'pending_verification');
  assert.equal(order!.checkoutStep, 'complete');

  // While the order was open, the prompt told the model what to ask next.
  const midway = prompts.find((p) => (p.messages[0]!.content as string).includes('Order in progress: #1001'));
  assert.ok(midway);
});
