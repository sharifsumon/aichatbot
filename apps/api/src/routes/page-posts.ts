import { and, desc, eq, ne } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { activities, channels, pagePosts, type Db } from '@agently/db';
import { GraphApiError, type GraphClient } from '@agently/meta';
import { decryptSecret } from '@agently/shared';
import { workspaceKey } from '@agently/storage';
import { ALL_ROLES, MANAGERS, requireRole } from './guard.ts';
import { MAX_POST_PHOTOS, MAX_POST_TEXT, postUrl } from './facebook-posts.ts';
import { parseBody } from './validate.ts';

const body = z
  .object({
    /** The page to post on; may be left out when the shop has one connected page. */
    channelId: z.string().uuid().optional(),
    message: z.string().trim().max(MAX_POST_TEXT, `A post can be at most ${MAX_POST_TEXT} characters`).default(''),
    photoUrls: z.array(z.string()).max(MAX_POST_PHOTOS, `A post can have at most ${MAX_POST_PHOTOS} photos`).default([]),
    videoUrl: z.string().nullish(),
  })
  .refine((b) => b.message || b.photoUrls.length || b.videoUrl, 'Write something, or add photos or a video')
  // Facebook takes several photos or one video in a post, not both.
  .refine((b) => !(b.videoUrl && b.photoUrls.length), 'A post can have photos or a video, not both');

export interface PagePostDeps {
  db: Db;
  graph: Pick<GraphClient, 'publishPost' | 'publishVideo'>;
  encryptionKey: string;
  /** Where uploads are served from; Facebook downloads the photos and video from there. */
  publicFileUrl?: (key: string) => string;
}

type Params = { workspaceId: string };

/** "What's on your mind?" posts on the shop's Facebook page: text, photos or a video. Owners and admins post; everyone sees past posts. */
export const pagePostRoutes: FastifyPluginAsync<PagePostDeps> = async (app, deps) => {
  const { db } = deps;

  app.get<{ Params: Params }>('/workspaces/:workspaceId/page-posts', async (req, reply) => {
    if (!(await requireRole(db, req, reply, ALL_ROLES))) return reply;
    const rows = await db
      .select({
        id: pagePosts.id,
        postId: pagePosts.postId,
        message: pagePosts.message,
        photoUrls: pagePosts.photoUrls,
        videoUrl: pagePosts.videoUrl,
        createdAt: pagePosts.createdAt,
        pageName: channels.name,
        pageId: channels.externalId,
      })
      .from(pagePosts)
      .innerJoin(channels, eq(channels.id, pagePosts.channelId))
      .where(eq(pagePosts.workspaceId, req.params.workspaceId))
      .orderBy(desc(pagePosts.createdAt))
      .limit(30);
    return { posts: rows.map(({ pageId, ...r }) => ({ ...r, url: r.videoUrl ? videoPostUrl(pageId, r.postId) : postUrl(r.postId) })) };
  });

  app.post<{ Params: Params }>('/workspaces/:workspaceId/page-posts', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    const { workspaceId } = req.params;
    const b = await parseBody(body, req.body, reply);
    if (!b) return reply;

    // Only this shop's own uploads: Facebook can fetch them, and nobody posts someone else's files through us.
    if (b.photoUrls.length || b.videoUrl) {
      if (!deps.publicFileUrl) return reply.code(503).send({ error: 'Uploads are not set up yet' });
      const own = deps.publicFileUrl(workspaceKey(workspaceId, '')).replace(/[^/]*$/, '');
      if ([...b.photoUrls, ...(b.videoUrl ? [b.videoUrl] : [])].some((u) => !u.startsWith(own))) {
        return reply.code(400).send({ error: 'Upload the photos and video here, then post them' });
      }
    }

    const pages = await db.query.channels.findMany({
      where: and(eq(channels.workspaceId, workspaceId), eq(channels.type, 'facebook_page'), ne(channels.status, 'disconnected')),
    });
    const page = b.channelId ? pages.find((p) => p.id === b.channelId) : pages.length === 1 ? pages[0] : undefined;
    if (!page) return reply.code(pages.length ? 400 : 409).send({ error: pages.length ? 'Choose the page to post on' : 'Connect your Facebook page first' });
    if (page.status !== 'connected' || !page.accessTokenEncrypted) {
      return reply.code(409).send({ error: `${page.name} needs to be reconnected in Settings before you can post.` });
    }

    const photoUrls = [...new Set(b.photoUrls)];
    const token = decryptSecret(page.accessTokenEncrypted, deps.encryptionKey);
    let postId: string;
    try {
      postId = b.videoUrl
        ? await deps.graph.publishVideo(token, page.externalId, { fileUrl: b.videoUrl, description: b.message })
        : await deps.graph.publishPost(token, page.externalId, { message: b.message, photoUrls });
    } catch (err) {
      if (!(err instanceof GraphApiError)) throw err;
      req.log.warn({ err, channelId: page.id }, 'Publishing a page post failed');
      if (err.tokenInvalid) {
        await db.update(channels).set({ status: 'token_expired', lastError: err.message }).where(eq(channels.id, page.id));
        return reply.code(409).send({ error: `Facebook signed ${page.name} out. Reconnect it in Settings, then post again.` });
      }
      if (err.permissionMissing) {
        return reply.code(403).send({
          error: `Facebook has not given Agently permission to post on ${page.name} yet. Sign in with Facebook again, allow "Create and manage content on your Page", and reconnect the page in Settings.`,
          reconnect: true,
        });
      }
      return reply.code(502).send({ error: `Facebook refused the post: ${err.message}` });
    }

    const [row] = await db
      .insert(pagePosts)
      .values({ workspaceId, channelId: page.id, postId, message: b.message, photoUrls, videoUrl: b.videoUrl ?? null, createdByUserId: req.user.id })
      .returning();
    await db.insert(activities).values({
      workspaceId,
      type: 'page.posted',
      text: `New ${b.videoUrl ? 'video' : photoUrls.length ? 'photo post' : 'post'} on ${page.name}`,
      actorUserId: req.user.id,
      data: { postId, channelId: page.id },
    });
    const url = b.videoUrl ? videoPostUrl(page.externalId, postId) : postUrl(postId);
    return reply.code(201).send({ post: { id: row!.id, postId, url, pageName: page.name, createdAt: row!.createdAt } });
  });
};

const videoPostUrl = (pageId: string, videoId: string) => `https://www.facebook.com/${encodeURIComponent(pageId)}/videos/${encodeURIComponent(videoId)}`;
