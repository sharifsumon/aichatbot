/**
 * Test setup before the dashboard exists: creates your shop and connects your
 * Facebook page, so you can message the page and watch the bot answer.
 *
 * 1. In the Graph API Explorer (developers.facebook.com/tools/explorer), pick
 *    your Agently app, add the permissions pages_show_list, pages_manage_metadata,
 *    pages_messaging, pages_read_engagement, pages_manage_engagement and
 *    pages_read_user_content, and click "Generate Access Token".
 * 2. List your pages:      FB_USER_TOKEN=... pnpm shop:connect
 * 3. Connect one:          FB_USER_TOKEN=... PAGE_ID=... SHOP_NAME="My Shop" pnpm shop:connect
 *    Add SAMPLE=1 for a demo product and a short knowledge text to test with.
 *
 * Run it again with the same page to refresh its token. The bot is switched
 * live; in development mode only people with a role on the Meta app get replies.
 */
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { and, asc, eq } from 'drizzle-orm';
import {
  activities,
  agents,
  authAccounts,
  channels,
  createDb,
  creditGrants,
  knowledgeSources,
  memberships,
  plans,
  productVariants,
  products,
  users,
  workspaces,
} from '@agently/db';
import { FacebookApp } from '@agently/meta';
import { QUEUES, encryptSecret, jobIdFor, loadEnv, type KnowledgeJob } from '@agently/shared';

const env = loadEnv('database', 'redis', 'meta', 'crypto');
const shortToken = process.env.FB_USER_TOKEN?.trim();
if (!shortToken) throw new Error('Set FB_USER_TOKEN to a user token from the Graph API Explorer');
const fb = new FacebookApp({ appId: env.META_APP_ID, appSecret: env.META_APP_SECRET, version: env.META_GRAPH_VERSION });

const { accessToken: userToken, expiresAt } = await fb.longLivedUserToken(shortToken);
const me = await fb.me(userToken);
const pages = await fb.pages(userToken);
const pageId = process.env.PAGE_ID?.trim();
if (!pageId) {
  console.log(`Signed in as ${me.name}. Your pages:`);
  for (const p of pages) console.log(`  ${p.id}  ${p.name}${p.tasks.includes('MESSAGING') ? '' : '  (no messaging permission)'}`);
  console.log('Run again with PAGE_ID=<id> to connect one.');
  process.exit(0);
}
const page = pages.find((p) => p.id === pageId);
if (!page) throw new Error(`You don't manage page ${pageId}. Run without PAGE_ID to list your pages.`);
if (!page.tasks.includes('MESSAGING')) throw new Error(`You need permission to send messages as ${page.name}`);

const { db, close } = createDb(env.DATABASE_URL, { max: 2 });
const encrypt = (v: string) => encryptSecret(v, env.ENCRYPTION_KEY);

// The same identity the Facebook sign-in uses, so signing in later finds this account.
let account = await db.query.authAccounts.findFirst({ where: and(eq(authAccounts.provider, 'facebook'), eq(authAccounts.providerAccountId, me.id)) });
if (!account) {
  // Accounts are never merged by email: if another user has this email, this one goes without it.
  const emailTaken = me.email ? !!(await db.query.users.findFirst({ where: eq(users.email, me.email) })) : true;
  const [user] = await db.insert(users).values({ name: me.name, email: emailTaken ? null : me.email! }).returning();
  [account] = await db.insert(authAccounts).values({ userId: user!.id, provider: 'facebook', providerAccountId: me.id }).returning();
}
await db.update(authAccounts).set({ accessTokenEncrypted: encrypt(userToken), tokenExpiresAt: expiresAt ?? null }).where(eq(authAccounts.id, account!.id));
const userId = account!.userId;

let channel = await db.query.channels.findFirst({ where: and(eq(channels.type, 'facebook_page'), eq(channels.externalId, page.id)) });
let workspaceId = channel?.workspaceId;
if (!workspaceId) {
  const name = process.env.SHOP_NAME?.trim() || page.name;
  const trial = await db.query.plans.findFirst({ where: eq(plans.key, 'trial') });
  const trialEndsAt = new Date(Date.now() + (trial?.trialDays ?? 14) * 864e5);
  const [ws] = await db.insert(workspaces).values({ name, status: 'trial', planId: trial?.id, trialEndsAt }).returning();
  workspaceId = ws!.id;
  await db.insert(memberships).values({ workspaceId, userId, role: 'owner' });
  await db.insert(agents).values({ workspaceId, name: `${name} assistant` });
  await db.insert(creditGrants).values({ workspaceId, reason: 'plan', credits: trial?.limits.aiCreditsPerMonth ?? 300, expiresAt: trialEndsAt });
  console.log(`Created shop "${name}" on the free trial.`);
}
const agent = (await db.query.agents.findFirst({ where: eq(agents.workspaceId, workspaceId), orderBy: asc(agents.createdAt) }))!;

await fb.subscribePage(page.id, page.accessToken);
const values = { workspaceId, agentId: agent.id, name: page.name, accessTokenEncrypted: encrypt(page.accessToken), status: 'connected' as const, lastError: null };
[channel] = channel
  ? await db.update(channels).set(values).where(eq(channels.id, channel.id)).returning()
  : await db.insert(channels).values({ ...values, type: 'facebook_page', externalId: page.id }).returning();
await db.update(agents).set({ status: 'live' }).where(eq(agents.id, agent.id));
await db.insert(activities).values({ workspaceId, type: 'channel.connected', text: `Facebook page ${page.name} connected`, actorUserId: userId, data: { channelId: channel!.id } });
console.log(`Connected ${page.name} and switched the bot live.`);

if (process.env.SAMPLE === '1') {
  const existing = await db.query.products.findFirst({ where: and(eq(products.workspaceId, workspaceId), eq(products.code, 'TS-01')) });
  if (!existing) {
    const [p] = await db
      .insert(products)
      .values({ workspaceId, title: 'Cotton T-shirt', code: 'TS-01', description: '100% cotton, regular fit.', price: '850' })
      .returning();
    await db.insert(productVariants).values(
      [['Black', 'M', 5], ['Black', 'L', 3], ['White', 'M', 4], ['White', 'L', 0]].map(([color, size, stock]) => ({
        workspaceId: workspaceId!,
        productId: p!.id,
        color: color as string,
        size: size as string,
        stock: stock as number,
      })),
    );
  }
  const [source] = await db
    .insert(knowledgeSources)
    .values({
      workspaceId,
      agentId: agent.id,
      type: 'text',
      name: 'Shop basics (sample)',
      content:
        'Delivery takes 1-2 days inside Dhaka and 3-5 days outside Dhaka. Delivery charge is 60 taka inside Dhaka and 120 taka outside. ' +
        'You can return a product within 7 days if it is unused. We take cash on delivery. Our shop is open 10am to 10pm every day.',
    })
    .returning();
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue<KnowledgeJob>(QUEUES.knowledge, { connection: redis });
  await queue.add('sync', { workspaceId, sourceId: source!.id }, { jobId: jobIdFor('kb', `${source!.id}-0`), attempts: 3 });
  await queue.close();
  redis.disconnect();
  console.log('Added a sample product (TS-01) and a knowledge text; the worker is reading it now.');
}

console.log(`Shop id: ${workspaceId}. Message ${page.name} on Messenger from an account with a role on the Meta app to try it.`);
await close();
