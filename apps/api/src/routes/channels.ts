import { randomInt } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { CHANNEL_NAMES, channelLimit, channelsInUse, limitsFor, type CountedChannel } from '@agently/billing';
import { activities, agents, authAccounts, channels, type ChannelMeta, type Db } from '@agently/db';
import { GraphApiError, type FacebookApp, type GraphClient } from '@agently/meta';
import { decryptSecret, encryptSecret } from '@agently/shared';
import { MANAGERS, requireRole } from './guard.ts';
import { parseBody } from './validate.ts';

export interface ChannelDeps {
  db: Db;
  facebook: Pick<FacebookApp, 'instagramAccounts' | 'subscribeInstagramPage' | 'exchangeSignupCode'>;
  graph: Pick<GraphClient, 'whatsAppNumber' | 'subscribeWhatsApp' | 'registerWhatsApp'>;
  encryptionKey: string;
  /** WhatsApp Embedded Signup; without it shops connect a number by pasting its details. */
  whatsappSignup?: { appId: string; configId: string; version: string };
}

const COUNTED: CountedChannel[] = ['facebook_page', 'whatsapp', 'instagram'];

const metaId = z.string().trim().regex(/^\d{5,30}$/, 'must be the number Meta shows, digits only');

const whatsappManualBody = z
  .object({ phoneNumberId: metaId, wabaId: metaId, accessToken: z.string().trim().min(20).max(1000) })
  .strict();

const whatsappSignupBody = z.object({ code: z.string().trim().min(10).max(2000), phoneNumberId: metaId, wabaId: metaId }).strict();

/** Connecting Instagram accounts and WhatsApp numbers, and how many of each the plan allows. */
export const channelRoutes: FastifyPluginAsync<ChannelDeps> = async (app, deps) => {
  const { db } = deps;

  /** Channels in use against the plan, per type. */
  app.get<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/channels/usage', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    const { workspaceId } = req.params;
    const [limits, ...used] = await Promise.all([limitsFor(db, workspaceId), ...COUNTED.map((t) => channelsInUse(db, workspaceId, t))]);
    return {
      usage: Object.fromEntries(COUNTED.map((t, i) => [t, { used: used[i], limit: channelLimit(limits, t) }])),
      whatsappSignup: deps.whatsappSignup ?? null,
    };
  });

  /** Instagram professional accounts linked to the user's pages, and which are already connected. */
  app.get<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/instagram/accounts', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    const accounts = await listInstagram(req.user.id, reply);
    if (!accounts) return reply;
    const connected = await db.select({ externalId: channels.externalId, workspaceId: channels.workspaceId, status: channels.status }).from(channels).where(eq(channels.type, 'instagram'));
    return {
      accounts: accounts.map((a) => {
        const c = connected.find((x) => x.externalId === a.id && x.status !== 'disconnected');
        return {
          id: a.id,
          username: a.username,
          pageName: a.page.name,
          canMessage: a.page.tasks.includes('MESSAGING'),
          connected: c ? (c.workspaceId === req.params.workspaceId ? 'this_workspace' : 'other_workspace') : null,
        };
      }),
    };
  });

  app.post<{ Params: { workspaceId: string; accountId: string } }>('/workspaces/:workspaceId/instagram/accounts/:accountId/connect', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    const { workspaceId, accountId } = req.params;
    const accounts = await listInstagram(req.user.id, reply);
    if (!accounts) return reply;
    const account = accounts.find((a) => a.id === accountId);
    if (!account) return reply.code(404).send({ error: 'This Instagram account is not linked to a page you manage' });
    if (!account.page.tasks.includes('MESSAGING')) return reply.code(403).send({ error: `You need permission to send messages as ${account.page.name}` });

    const existing = await findChannel('instagram', account.id);
    if (!(await roomFor(workspaceId, 'instagram', existing, reply))) return reply;

    try {
      await deps.facebook.subscribeInstagramPage(account.page.id, account.page.accessToken);
    } catch (err) {
      req.log.warn({ err, accountId }, 'Instagram page subscription failed');
      return reply.code(502).send({ error: 'Meta did not let us connect this account. Try again in a minute.' });
    }

    const channel = await saveChannel(req.user.id, workspaceId, existing, {
      type: 'instagram',
      externalId: account.id,
      name: `@${account.username}`,
      token: account.page.accessToken,
      meta: { pageId: account.page.id, pageName: account.page.name, username: account.username },
    });
    return { channel };
  });

  /** A WhatsApp number from its Meta details: phone number id, WhatsApp Business Account id and a permanent token. */
  app.post<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/whatsapp/connect', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    const body = await parseBody(whatsappManualBody, req.body, reply);
    if (!body) return reply;
    return connectWhatsApp(req.user.id, req.params.workspaceId, body, reply, req.log);
  });

  /** WhatsApp Embedded Signup: the popup's code plus the number and account the shop picked in it. */
  app.post<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/whatsapp/signup', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    if (!deps.whatsappSignup) return reply.code(503).send({ error: 'WhatsApp signup is not set up yet' });
    const body = await parseBody(whatsappSignupBody, req.body, reply);
    if (!body) return reply;
    let accessToken: string;
    try {
      accessToken = await deps.facebook.exchangeSignupCode(body.code);
    } catch (err) {
      req.log.warn({ err }, 'WhatsApp signup code exchange failed');
      return reply.code(502).send({ error: 'Meta did not finish the WhatsApp signup. Try again.' });
    }
    return connectWhatsApp(req.user.id, req.params.workspaceId, { ...body, accessToken }, reply, req.log, { register: true });
  });

  async function connectWhatsApp(
    userId: string,
    workspaceId: string,
    d: { phoneNumberId: string; wabaId: string; accessToken: string },
    reply: FastifyReply,
    log: { warn: (o: object, m: string) => void },
    opts: { register?: boolean } = {},
  ) {
    let number;
    try {
      number = await deps.graph.whatsAppNumber(d.accessToken, d.phoneNumberId);
    } catch (err) {
      log.warn({ err }, 'WhatsApp number check failed');
      const msg = err instanceof GraphApiError ? err.message : 'no answer';
      return reply.code(400).send({ error: `Meta did not accept these details (${msg}). Check the phone number ID and the access token.` });
    }

    const existing = await findChannel('whatsapp', d.phoneNumberId);
    if (!(await roomFor(workspaceId, 'whatsapp', existing, reply))) return reply;

    if (opts.register) {
      // A number fresh from signup must be registered before it can send; one already registered refuses, which is fine.
      await deps.graph.registerWhatsApp(d.accessToken, d.phoneNumberId, String(randomInt(100000, 1000000))).catch((err: unknown) => log.warn({ err }, 'WhatsApp register skipped'));
    }
    try {
      await deps.graph.subscribeWhatsApp(d.accessToken, d.wabaId);
    } catch (err) {
      log.warn({ err }, 'WhatsApp webhook subscription failed');
      const msg = err instanceof GraphApiError ? err.message : 'no answer';
      return reply.code(502).send({ error: `Meta did not let us receive this number's messages (${msg}). Check the WhatsApp Business Account ID.` });
    }

    const display = number.displayPhoneNumber ? `+${number.displayPhoneNumber.replace(/^\+/, '')}` : d.phoneNumberId;
    const channel = await saveChannel(userId, workspaceId, existing, {
      type: 'whatsapp',
      externalId: d.phoneNumberId,
      name: number.verifiedName ? `${number.verifiedName} (${display})` : display,
      token: d.accessToken,
      meta: { wabaId: d.wabaId, displayPhoneNumber: display },
    });
    return { channel };
  }

  const findChannel = (type: 'instagram' | 'whatsapp', externalId: string) =>
    db.query.channels.findFirst({ where: and(eq(channels.type, type), eq(channels.externalId, externalId)) });

  /** Refuses (and replies) when the channel belongs to another shop, or the plan has no room for a new one. */
  async function roomFor(workspaceId: string, type: CountedChannel, existing: typeof channels.$inferSelect | undefined, reply: FastifyReply): Promise<boolean> {
    const names = CHANNEL_NAMES[type];
    if (existing && existing.workspaceId !== workspaceId && existing.status !== 'disconnected') {
      await reply.code(409).send({ error: `This ${names.one} is already connected to another shop on Agently` });
      return false;
    }
    // Reconnecting one this shop already has is always fine.
    if (existing?.workspaceId === workspaceId && existing.status !== 'disconnected') return true;
    const [used, limits] = await Promise.all([channelsInUse(db, workspaceId, type), limitsFor(db, workspaceId)]);
    const limit = channelLimit(limits, type);
    if (used >= limit) {
      await reply.code(402).send({
        error:
          limit === 0
            ? `Your plan does not include ${names.many}. Upgrade to Starter or above to connect one.`
            : `Your plan allows ${limit} ${limit === 1 ? names.one : names.many}. Disconnect one or upgrade to add another.`,
        limit: type,
      });
      return false;
    }
    return true;
  }

  async function saveChannel(
    userId: string,
    workspaceId: string,
    existing: typeof channels.$inferSelect | undefined,
    c: { type: 'instagram' | 'whatsapp'; externalId: string; name: string; token: string; meta: ChannelMeta },
  ) {
    // The shop's bot for this channel type answers here; without one, chats wait for staff.
    const agent = await db.query.agents.findFirst({
      columns: { id: true },
      where: and(eq(agents.workspaceId, workspaceId), eq(agents.channelType, c.type)),
      orderBy: [asc(agents.createdAt), asc(agents.id)],
    });
    const values = {
      workspaceId,
      agentId: agent?.id ?? null,
      name: c.name,
      accessTokenEncrypted: encryptSecret(c.token, deps.encryptionKey),
      status: 'connected' as const,
      lastError: null,
      meta: c.meta,
    };
    const [channel] = existing
      ? await db.update(channels).set(values).where(eq(channels.id, existing.id)).returning()
      : await db.insert(channels).values({ ...values, type: c.type, externalId: c.externalId }).returning();
    await db.insert(activities).values({
      workspaceId,
      type: 'channel.connected',
      text: `${c.type === 'whatsapp' ? 'WhatsApp number' : 'Instagram account'} ${c.name} connected`,
      actorUserId: userId,
      data: { channelId: channel!.id },
    });
    return { id: channel!.id, type: channel!.type, name: channel!.name, status: channel!.status, hasAgent: !!agent };
  }

  /** Instagram accounts via the user's stored Facebook token; replies and returns undefined when they must sign in again. */
  async function listInstagram(userId: string, reply: FastifyReply) {
    const account = await db.query.authAccounts.findFirst({
      where: and(eq(authAccounts.userId, userId), eq(authAccounts.provider, 'facebook')),
    });
    const again = { error: 'Sign in with Facebook again and allow Instagram messages', reconnect: true };
    if (!account?.accessTokenEncrypted) {
      await reply.code(409).send(again);
      return undefined;
    }
    try {
      return await deps.facebook.instagramAccounts(decryptSecret(account.accessTokenEncrypted, deps.encryptionKey));
    } catch (err) {
      if (err instanceof GraphApiError && (err.tokenInvalid || err.permissionMissing)) {
        await reply.code(409).send(again);
        return undefined;
      }
      throw err;
    }
  }
};
