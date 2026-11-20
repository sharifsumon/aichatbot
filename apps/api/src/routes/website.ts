import { randomBytes } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { activities, agents, channels, knowledgeChunks, knowledgeSources, type ChannelMeta, type Db } from '@agently/db';
import type { KnowledgeJob } from '@agently/shared';
import { MANAGERS, requireRole } from './guard.ts';
import { parseBody } from './validate.ts';

export interface WebsiteDeps {
  db: Db;
  enqueueKnowledge: (job: KnowledgeJob) => Promise<void>;
  /** The API's public address: the widget script and its chat calls are served from it. */
  urls: { api: string };
}

export const DEFAULT_WELCOME = 'Hi! How can we help you today?';
export const DEFAULT_COLOR = '#2563eb';

const siteUrl = z
  .string()
  .trim()
  .url('must be a web address like https://myshop.com')
  .refine((u) => /^https?:\/\//i.test(u), 'must start with http:// or https://')
  .transform((u) => {
    const url = new URL(u);
    url.hash = '';
    return url.toString();
  });

const websiteBody = z.discriminatedUnion('enabled', [
  z
    .object({
      enabled: z.literal(true),
      url: siteUrl,
      welcomeMessage: z.string().trim().min(1).max(300).optional(),
      color: z
        .string()
        .trim()
        .regex(/^#[0-9a-fA-F]{6}$/, 'must be a colour like #2563eb')
        .optional(),
    })
    .strict(),
  z.object({ enabled: z.literal(false) }).passthrough(),
]);

/**
 * Website chat: an opt-in channel. Ticking it on in Settings creates the shop's
 * widget (one per shop) and adds the site to the knowledge base, so the bot
 * answers from the site's pages as well as everything else it knows.
 */
export const websiteRoutes: FastifyPluginAsync<WebsiteDeps> = async (app, deps) => {
  const { db } = deps;
  const apiBase = deps.urls.api.replace(/\/+$/, '');

  app.get<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/website', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    const channel = await widgetChannel(db, req.params.workspaceId);
    return { website: channel ? await websiteOf(db, channel, apiBase) : null };
  });

  app.put<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/website', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    const body = await parseBody(websiteBody, req.body, reply);
    if (!body) return reply;
    const { workspaceId } = req.params;
    const existing = await widgetChannel(db, workspaceId);

    if (!body.enabled) {
      if (!existing) return { website: null };
      if (existing.status !== 'disconnected') {
        await db.update(channels).set({ status: 'disconnected' }).where(eq(channels.id, existing.id));
        await db.insert(activities).values({
          workspaceId,
          type: 'channel.disconnected',
          text: 'Website chat turned off',
          actorUserId: req.user.id,
          data: { channelId: existing.id },
        });
      }
      const updated = (await widgetChannel(db, workspaceId))!;
      return { website: await websiteOf(db, updated, apiBase) };
    }

    const host = new URL(body.url).hostname.replace(/^www\./, '');
    const result = await db.transaction(async (tx) => {
      // The main bot answers website chats; a shop doesn't need a spare agent for it.
      const main =
        (await tx.query.agents.findFirst({ where: and(eq(agents.workspaceId, workspaceId), eq(agents.channelType, 'widget')) })) ??
        (await tx.query.agents.findFirst({ where: and(eq(agents.workspaceId, workspaceId), eq(agents.channelType, 'facebook_page')), orderBy: asc(agents.createdAt) })) ??
        (await tx.query.agents.findFirst({ where: eq(agents.workspaceId, workspaceId), orderBy: asc(agents.createdAt) }));

      // The site goes into the knowledge base; a new address is crawled again.
      const oldSource = existing?.meta.knowledgeSourceId
        ? await tx.query.knowledgeSources.findFirst({
            where: and(eq(knowledgeSources.id, existing.meta.knowledgeSourceId), eq(knowledgeSources.workspaceId, workspaceId)),
          })
        : undefined;
      let sourceId = oldSource?.id;
      let crawl = false;
      if (!oldSource) {
        const [source] = await tx
          .insert(knowledgeSources)
          .values({ workspaceId, agentId: main?.id ?? null, type: 'website', name: `Website: ${host}`, url: body.url, status: 'queued' })
          .returning();
        sourceId = source!.id;
        crawl = true;
        await tx.insert(activities).values({
          workspaceId,
          type: 'knowledge.added',
          text: `${source!.name} added to the knowledge base`,
          actorUserId: req.user.id,
          data: { sourceId },
        });
      } else if (oldSource.url !== body.url) {
        await tx.update(knowledgeSources).set({ url: body.url, name: `Website: ${host}`, status: 'queued', error: null }).where(eq(knowledgeSources.id, oldSource.id));
        crawl = true;
      }

      const meta: ChannelMeta = {
        websiteUrl: body.url,
        knowledgeSourceId: sourceId,
        welcomeMessage: body.welcomeMessage ?? existing?.meta.welcomeMessage ?? DEFAULT_WELCOME,
        color: body.color ?? existing?.meta.color ?? DEFAULT_COLOR,
      };
      const values = { name: host, status: 'connected' as const, lastError: null, meta, agentId: existing?.agentId ?? main?.id ?? null };
      const [channel] = existing
        ? await tx.update(channels).set(values).where(eq(channels.id, existing.id)).returning()
        : await tx
            .insert(channels)
            .values({ ...values, workspaceId, type: 'widget', externalId: `wk_${randomBytes(18).toString('base64url')}` })
            .returning();
      if (!existing || existing.status === 'disconnected') {
        await tx.insert(activities).values({
          workspaceId,
          type: 'channel.connected',
          text: `Website chat turned on for ${host}`,
          actorUserId: req.user.id,
          data: { channelId: channel!.id },
        });
      }
      return { channel: channel!, crawl, sourceId: sourceId! };
    });

    if (result.crawl) await deps.enqueueKnowledge({ workspaceId, sourceId: result.sourceId });
    return { website: await websiteOf(db, result.channel, apiBase) };
  });
};

/** The shop's widget, on or off. There is at most one per shop. */
export function widgetChannel(db: Db, workspaceId: string) {
  return db.query.channels.findFirst({
    where: and(eq(channels.workspaceId, workspaceId), eq(channels.type, 'widget')),
    orderBy: asc(channels.createdAt),
  });
}

/** The snippet a shop pastes before </body> on every page of its site. */
export function widgetSnippet(apiBase: string, key: string): string {
  return `<script src="${apiBase}/widget.js" data-agently-key="${key}" async></script>`;
}

async function websiteOf(db: Db, channel: typeof channels.$inferSelect, apiBase: string) {
  const sourceId = channel.meta.knowledgeSourceId;
  const [source] = sourceId
    ? await db
        .select({
          id: knowledgeSources.id,
          status: knowledgeSources.status,
          error: knowledgeSources.error,
          lastSyncedAt: knowledgeSources.lastSyncedAt,
          chunks: sql<number>`(select count(*)::int from ${knowledgeChunks} where ${knowledgeChunks.sourceId} = ${knowledgeSources.id})`,
        })
        .from(knowledgeSources)
        .where(eq(knowledgeSources.id, sourceId))
    : [];
  return {
    channelId: channel.id,
    enabled: channel.status !== 'disconnected',
    key: channel.externalId,
    url: channel.meta.websiteUrl ?? null,
    welcomeMessage: channel.meta.welcomeMessage ?? DEFAULT_WELCOME,
    color: channel.meta.color ?? DEFAULT_COLOR,
    snippet: widgetSnippet(apiBase, channel.externalId),
    // Removed from the knowledge base by hand: the bot then answers without the site's pages.
    knowledge: source ?? null,
  };
}
