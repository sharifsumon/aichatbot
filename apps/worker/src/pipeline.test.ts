/**
 * Runs the inbound → reply pipeline against a real Postgres with fake AI and
 * Meta clients. Needs DATABASE_URL pointing at a migrated database; skipped otherwise.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { pino } from 'pino';
import type { AIProvider, ChatRequest } from '@agently/ai';
import { AIProviderError } from '@agently/ai';
import {
  EMBEDDING_DIMENSIONS,
  activities,
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
import { checkPageTokens } from './page-health.ts';
import { GraphApiError } from '@agently/meta';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL not set';
const key = randomBytes(32).toString('base64');

let db: Db;
let close: () => Promise<void>;
let sent: { psid: string; text: string }[];
let sentImages: { psid: string; url: string }[];
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
      sendImage: async (_token, psid, url) => {
        sentImages.push({ psid, url });
        return `img-out-${randomBytes(6).toString('hex')}`;
      },
      checkPageToken: async () => {},
      replyToComment: async () => 'c-out',
      privateReply: async () => 'p-out',
    },
    enqueueReply: async (job) => {
      queued.push(job);
    },
    enqueueKnowledge: async () => {},
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
  sentImages = [];
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

test('sends the photo of the colour the customer asked for, after the text', { skip }, async () => {
  const page = `page-${randomBytes(4).toString('hex')}`;
  const ws = await makeShop(page);
  const main = 'https://socialbot.test/media/main.jpg';
  const blue = 'https://socialbot.test/media/blue.jpg';
  await db.update(products).set({ imageUrl: main, images: [{ url: main, color: '' }, { url: blue, color: 'Blue' }] }).where(eq(products.workspaceId, ws.id));

  const calls: Record<string, Record<string, unknown>> = {
    'blue ta dekhan': { code: 'sh-01', color: 'blue' },
    'chobi den': { code: 'SH-01' },
    'red ta?': { code: 'SH-01', color: 'Red' },
  };
  const toolResults: string[] = [];
  aiImpl = async (req) => {
    prompts.push(req);
    const last = req.messages.at(-1)!;
    if (last.role === 'tool') {
      toolResults.push(last.content);
      return { text: 'Ei je', toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, model: 'fake' };
    }
    const args = calls[last.content];
    return { text: '', toolCalls: args ? [{ id: 'c1', name: 'send_product_photos', arguments: args }] : [], usage: { inputTokens: 10, outputTokens: 5 }, model: 'fake' };
  };

  const expected = [[blue], [main], [main]];
  for (const [i, text] of Object.keys(calls).entries()) {
    sentImages = [];
    await handleInbound(deps(), inbound(page, `${page}-${i}`, text, Date.now()));
    assert.equal(await handleReply(deps(), queued.at(-1)!, { finalAttempt: false }), 'sent');
    assert.deepEqual(sentImages.map((s) => s.url), expected[i], text);
  }
  // No photo of Red: the main photo goes, and the model is told to say so.
  assert.match(toolResults[2]!, /no photo of that colour/);
  // The prompt lists which colours have photos.
  assert.match(prompts[0]!.messages[0]!.content as string, /Photos: main, and for Blue/);

  // Photos are saved in the conversation after the text, as image attachments.
  const out = await db.select().from(messages).where(and(eq(messages.workspaceId, ws.id), eq(messages.direction, 'outbound')));
  const photos = out.filter((m) => m.attachments.length);
  assert.equal(photos.length, 3);
  assert.deepEqual(photos.map((m) => m.attachments[0]!.url).sort(), [blue, main, main].sort());
  assert.ok(photos.every((m) => m.delivery === 'sent' && m.text === ''));
});

test('a page whose token was revoked is marked for reconnecting, once', { skip }, async () => {
  const page = `page-${randomBytes(4).toString('hex')}`;
  const ws = await makeShop(page);
  const d = deps();
  const healthy = await checkPageTokens({ ...d, graph: { ...d.graph, checkPageToken: async () => {} } });
  assert.ok(healthy.checked >= 1);
  const [before] = await db.select().from(channels).where(eq(channels.workspaceId, ws.id));
  assert.equal(before!.status, 'connected');

  // An outage says nothing about the token.
  const outage = { ...d.graph, checkPageToken: async () => { throw new GraphApiError('Service unavailable', 503); } };
  await checkPageTokens({ ...d, graph: outage });
  assert.equal((await db.select().from(channels).where(eq(channels.workspaceId, ws.id)))[0]!.status, 'connected');

  const revoked = { ...d.graph, checkPageToken: async () => { throw new GraphApiError('Error validating access token: The user has not authorized application', 400, 190); } };
  await checkPageTokens({ ...d, graph: revoked });
  await checkPageTokens({ ...d, graph: revoked });
  const [after] = await db.select().from(channels).where(eq(channels.workspaceId, ws.id));
  assert.equal(after!.status, 'token_expired');
  assert.match(after!.lastError!, /not authorized/);
  // Checked pages are only connected ones, so the feed gets one entry, not one per run.
  const notes = await db.select().from(activities).where(and(eq(activities.workspaceId, ws.id), eq(activities.type, 'channel.token_expired')));
  assert.equal(notes.length, 1);
});

test('a post\'s Order now link opens the chat on that product, and the bot answers it', { skip }, async () => {
  const page = `page-${randomBytes(4).toString('hex')}`;
  const ws = await makeShop(page);
  const [product] = await db.select().from(products).where(eq(products.workspaceId, ws.id));
  const job: InboundJob = { ...inbound(page, `referral-${page}`, ''), referral: { ref: `order_${product!.id}` } };

  assert.equal(await handleInbound(deps(), job), 'saved');
  const [saved] = await db.select().from(messages).where(eq(messages.workspaceId, ws.id));
  assert.equal(saved!.text, 'I want to order Cotton Shirt (code SH-01).');
  assert.deepEqual(saved!.meta.referral, { ref: `order_${product!.id}`, productId: product!.id, intent: 'order' });

  assert.equal(await handleReply(deps(), queued[0]!, { finalAttempt: false }), 'sent');
  assert.match(prompts[0]!.messages[0]!.content, /came from your post about Cotton Shirt \[code SH-01\]/);

  // A ref for another shop's product, or junk, is just a hello.
  const other = await makeShop(`${page}-b`);
  const [foreign] = await db.select().from(products).where(eq(products.workspaceId, other.id));
  await handleInbound(deps(), { ...inbound(page, `referral-${page}-2`, ''), referral: { ref: `product_${foreign!.id}` } });
  const rows = await db.select().from(messages).where(and(eq(messages.workspaceId, ws.id), eq(messages.externalId, `referral-${page}-2`)));
  assert.equal(rows[0]!.text, 'Hi');
  assert.equal(rows[0]!.meta.referral?.productId, undefined);
});
