import { and, asc, eq } from 'drizzle-orm';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import type { FastifyPluginAsync } from 'fastify';
import {
  activities,
  agents,
  authAccounts,
  channels,
  creditGrants,
  memberships,
  plans,
  workspaces,
  type Db,
} from '@agently/db';
import { GraphApiError, type FacebookApp } from '@agently/meta';
import { decryptSecret, encryptSecret } from '@agently/shared';
import { sessionUser, type SessionUser } from '../auth/session.ts';
import { MANAGERS, isUuid, requireRole } from './guard.ts';
import { inboxRoutes, type InboxDeps } from './inbox.ts';
import { ordersRoutes } from './orders.ts';
import { catalogRoutes, type CatalogDeps } from './catalog.ts';
import { knowledgeRoutes, type KnowledgeDeps } from './knowledge.ts';
import { settingsRoutes } from './settings.ts';

export type DashboardDeps = InboxDeps & CatalogDeps & KnowledgeDeps & {
  db: Db;
  facebook: Pick<FacebookApp, 'pages' | 'subscribePage' | 'unsubscribePage'>;
  encryptionKey: string;
  urls: { web: string };
};

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser;
  }
}

const TRIAL_DAYS = 14;

/** JSON API for the shop dashboard. Every route needs a session; workspace routes need membership. */
export const dashboardApiRoutes: FastifyPluginAsync<DashboardDeps> = async (app, deps) => {
  const { db } = deps;
  const webOrigin = new URL(deps.urls.web).origin;

  // The dashboard runs on its own domain and calls this API with the session cookie.
  await app.register(cors, { origin: webOrigin, credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] });

  // Uploads (product photos, knowledge files). Each route sets its own size limit.
  await app.register(multipart, { limits: { files: 1, fields: 5, fileSize: 20 * 1024 * 1024 } });

  app.decorateRequest('user', null as unknown as SessionUser);
  app.addHook('preHandler', async (req, reply) => {
    // Cookies ride along on cross-site requests, so changes must come from our own web app.
    if (req.method !== 'GET' && req.headers.origin !== webOrigin) {
      return reply.code(403).send({ error: 'Bad origin' });
    }
    const user = await sessionUser(db, req);
    if (!user) return reply.code(401).send({ error: 'Not signed in' });
    req.user = user;
  });

  // Pass the deps without this plugin's own `prefix`, or the children would nest it twice.
  const { prefix: _prefix, ...childDeps } = deps as DashboardDeps & { prefix?: string };
  app.register(inboxRoutes, childDeps);
  app.register(ordersRoutes, childDeps);
  app.register(catalogRoutes, childDeps);
  app.register(knowledgeRoutes, childDeps);
  app.register(settingsRoutes, childDeps);

  app.get('/me', async (req) => {
    const rows = await db
      .select({ id: workspaces.id, name: workspaces.name, role: memberships.role, status: workspaces.status, onboardingCompletedAt: workspaces.onboardingCompletedAt })
      .from(memberships)
      .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
      .where(eq(memberships.userId, req.user.id))
      .orderBy(asc(workspaces.createdAt));
    return { user: req.user, workspaces: rows };
  });

  /** Onboarding: a new shop on the free trial, with one agent and the trial's AI credits. */
  app.post<{ Body: { name?: unknown } }>('/workspaces', async (req, reply) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (name.length < 2 || name.length > 80) return reply.code(400).send({ error: 'Shop name must be 2 to 80 characters' });

    const workspace = await db.transaction(async (tx) => {
      const trial = await tx.query.plans.findFirst({ where: eq(plans.key, 'trial') });
      const trialEndsAt = new Date(Date.now() + (trial?.trialDays ?? TRIAL_DAYS) * 864e5);
      const [ws] = await tx.insert(workspaces).values({ name, status: 'trial', planId: trial?.id, trialEndsAt }).returning();
      await tx.insert(memberships).values({ workspaceId: ws!.id, userId: req.user.id, role: 'owner' });
      await tx.insert(agents).values({ workspaceId: ws!.id, name: `${name} assistant` });
      if (trial) {
        await tx.insert(creditGrants).values({ workspaceId: ws!.id, reason: 'plan', credits: trial.limits.aiCreditsPerMonth, expiresAt: trialEndsAt });
      }
      return ws!;
    });
    return reply.code(201).send({ workspace: { id: workspace.id, name: workspace.name, status: workspace.status } });
  });

  /** Pages the signed-in user manages, and which are already connected. */
  app.get<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/facebook/pages', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;

    const pages = await listUserPages(req.user.id);
    if (!pages) return reply.code(409).send({ error: 'Sign in with Facebook again to see your pages', reconnect: true });

    const connected = await db.select({ externalId: channels.externalId, workspaceId: channels.workspaceId, status: channels.status }).from(channels).where(eq(channels.type, 'facebook_page'));
    return {
      pages: pages.map((p) => {
        const c = connected.find((x) => x.externalId === p.id && x.status !== 'disconnected');
        return {
          id: p.id,
          name: p.name,
          canMessage: p.tasks.includes('MESSAGING'),
          connected: c ? (c.workspaceId === req.params.workspaceId ? 'this_workspace' : 'other_workspace') : null,
        };
      }),
    };
  });

  app.post<{ Params: { workspaceId: string; pageId: string } }>('/workspaces/:workspaceId/facebook/pages/:pageId/connect', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    const { workspaceId, pageId } = req.params;

    // The page must be one this user manages right now, with permission to message.
    const pages = await listUserPages(req.user.id);
    if (!pages) return reply.code(409).send({ error: 'Sign in with Facebook again to see your pages', reconnect: true });
    const page = pages.find((p) => p.id === pageId);
    if (!page) return reply.code(404).send({ error: 'You do not manage this page' });
    if (!page.tasks.includes('MESSAGING')) return reply.code(403).send({ error: 'You need permission to send messages as this page' });

    const existing = await db.query.channels.findFirst({ where: and(eq(channels.type, 'facebook_page'), eq(channels.externalId, pageId)) });
    if (existing && existing.workspaceId !== workspaceId && existing.status !== 'disconnected') {
      return reply.code(409).send({ error: 'This page is already connected to another shop on Agently' });
    }

    try {
      await deps.facebook.subscribePage(page.id, page.accessToken);
    } catch (err) {
      req.log.warn({ err, pageId }, 'Page subscription failed');
      return reply.code(502).send({ error: 'Facebook did not let us connect this page. Try again in a minute.' });
    }

    const agent = await db.query.agents.findFirst({ where: eq(agents.workspaceId, workspaceId), orderBy: asc(agents.createdAt) });
    const values = {
      workspaceId,
      agentId: agent?.id ?? null,
      name: page.name,
      accessTokenEncrypted: encryptSecret(page.accessToken, deps.encryptionKey),
      status: 'connected' as const,
      lastError: null,
    };
    const [channel] = existing
      ? await db.update(channels).set(values).where(eq(channels.id, existing.id)).returning()
      : await db.insert(channels).values({ ...values, type: 'facebook_page', externalId: page.id }).returning();
    await db.insert(activities).values({
      workspaceId,
      type: 'channel.connected',
      text: `Facebook page ${page.name} connected`,
      actorUserId: req.user.id,
      data: { channelId: channel!.id },
    });
    return { channel: { id: channel!.id, name: channel!.name, status: channel!.status } };
  });

  app.post<{ Params: { workspaceId: string; channelId: string } }>('/workspaces/:workspaceId/channels/:channelId/disconnect', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    if (!isUuid(req.params.channelId)) return reply.code(404).send({ error: 'Channel not found' });
    const channel = await db.query.channels.findFirst({
      where: and(eq(channels.id, req.params.channelId), eq(channels.workspaceId, req.params.workspaceId)),
    });
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });

    if (channel.type === 'facebook_page' && channel.accessTokenEncrypted) {
      // Best effort: if the token is already revoked, Meta has stopped sending events anyway.
      await deps.facebook
        .unsubscribePage(channel.externalId, decryptSecret(channel.accessTokenEncrypted, deps.encryptionKey))
        .catch((err: unknown) => req.log.warn({ err }, 'Unsubscribe failed'));
    }
    await db.update(channels).set({ status: 'disconnected', accessTokenEncrypted: null }).where(eq(channels.id, channel.id));
    await db.insert(activities).values({
      workspaceId: channel.workspaceId,
      type: 'channel.disconnected',
      text: `${channel.name} disconnected`,
      actorUserId: req.user.id,
      data: { channelId: channel.id },
    });
    return reply.code(204).send();
  });

  /** The user's pages via their stored Facebook token; undefined when they must sign in again. */
  async function listUserPages(userId: string) {
    const account = await db.query.authAccounts.findFirst({
      where: and(eq(authAccounts.userId, userId), eq(authAccounts.provider, 'facebook')),
    });
    if (!account?.accessTokenEncrypted) return undefined;
    try {
      return await deps.facebook.pages(decryptSecret(account.accessTokenEncrypted, deps.encryptionKey));
    } catch (err) {
      if (err instanceof GraphApiError && err.tokenInvalid) return undefined;
      throw err;
    }
  }
};
