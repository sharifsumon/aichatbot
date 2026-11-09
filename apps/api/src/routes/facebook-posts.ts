import { and, desc, eq, ne } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { activities, channels, productPosts, products, type Db } from '@agently/db';
import { GraphApiError, type GraphClient } from '@agently/meta';
import { decryptSecret } from '@agently/shared';
import { ALL_ROLES, MANAGERS, isUuid, requireRole } from './guard.ts';
import { parseBody } from './validate.ts';

/** Facebook allows longer posts, but a product post this long is a mistake. */
export const MAX_POST_TEXT = 5000;
/** Facebook attaches at most 10 photos to one post through attached_media. */
export const MAX_POST_PHOTOS = 10;

const postBody = z.object({
  /** The page to post on; may be left out when the shop has one connected page. */
  channelId: z.string().uuid().optional(),
  message: z.string().trim().min(1, 'Write something for the post').max(MAX_POST_TEXT, `A post can be at most ${MAX_POST_TEXT} characters`),
  /** Chosen from the product's own photos, in the order they should appear. */
  photoUrls: z.array(z.string()).max(MAX_POST_PHOTOS, `A post can have at most ${MAX_POST_PHOTOS} photos`).default([]),
});

export interface FacebookPostDeps {
  db: Db;
  graph: Pick<GraphClient, 'publishPost'>;
  encryptionKey: string;
}

type Params = { workspaceId: string; productId: string };

/** Publishing a product as a post on the shop's Facebook page. Owners and admins post; everyone sees past posts. */
export const facebookPostRoutes: FastifyPluginAsync<FacebookPostDeps> = async (app, deps) => {
  const { db } = deps;

  app.get<{ Params: Params }>('/workspaces/:workspaceId/products/:productId/facebook-posts', async (req, reply) => {
    if (!(await requireRole(db, req, reply, ALL_ROLES))) return reply;
    if (!isUuid(req.params.productId)) return reply.code(404).send({ error: 'Product not found' });
    const rows = await db
      .select({ id: productPosts.id, postId: productPosts.postId, message: productPosts.message, photoUrls: productPosts.photoUrls, createdAt: productPosts.createdAt, pageName: channels.name })
      .from(productPosts)
      .innerJoin(channels, eq(channels.id, productPosts.channelId))
      .where(and(eq(productPosts.workspaceId, req.params.workspaceId), eq(productPosts.productId, req.params.productId)))
      .orderBy(desc(productPosts.createdAt))
      .limit(20);
    return { posts: rows.map((r) => ({ ...r, url: postUrl(r.postId) })) };
  });

  app.post<{ Params: Params }>('/workspaces/:workspaceId/products/:productId/facebook-posts', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    const { workspaceId, productId } = req.params;
    if (!isUuid(productId)) return reply.code(404).send({ error: 'Product not found' });
    const body = await parseBody(postBody, req.body, reply);
    if (!body) return reply;

    const product = await db.query.products.findFirst({ where: and(eq(products.id, productId), eq(products.workspaceId, workspaceId)) });
    if (!product || product.status === 'archived') return reply.code(404).send({ error: 'Product not found' });

    // Only the product's own photos: they are on our storage and Facebook can fetch them.
    const own = new Set(product.images.map((i) => i.url));
    if (body.photoUrls.some((u) => !own.has(u))) return reply.code(400).send({ error: 'Pick photos from this product' });
    const photoUrls = [...new Set(body.photoUrls)];

    const pages = await db.query.channels.findMany({
      where: and(eq(channels.workspaceId, workspaceId), eq(channels.type, 'facebook_page'), ne(channels.status, 'disconnected')),
    });
    const page = body.channelId ? pages.find((p) => p.id === body.channelId) : pages.length === 1 ? pages[0] : undefined;
    if (!page) {
      return reply.code(pages.length ? 400 : 409).send({ error: pages.length ? 'Choose the page to post on' : 'Connect your Facebook page first' });
    }
    if (page.status !== 'connected' || !page.accessTokenEncrypted) {
      return reply.code(409).send({ error: `${page.name} needs to be reconnected in Settings before you can post.` });
    }

    let postId: string;
    try {
      postId = await deps.graph.publishPost(decryptSecret(page.accessTokenEncrypted, deps.encryptionKey), page.externalId, { message: body.message, photoUrls });
    } catch (err) {
      if (!(err instanceof GraphApiError)) throw err;
      req.log.warn({ err, channelId: page.id }, 'Publishing a product post failed');
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
      .insert(productPosts)
      .values({ workspaceId, productId, channelId: page.id, postId, message: body.message, photoUrls, createdByUserId: req.user.id })
      .returning();
    await db.insert(activities).values({
      workspaceId,
      type: 'product.posted',
      text: `${product.title} posted on ${page.name}`,
      actorUserId: req.user.id,
      data: { productId, postId, channelId: page.id },
    });
    return reply.code(201).send({ post: { id: row!.id, postId, url: postUrl(postId), pageName: page.name, createdAt: row!.createdAt } });
  });
};

/** "{pageId}_{postId}" opens directly at facebook.com/{pageId}_{postId}. */
export const postUrl = (postId: string) => `https://www.facebook.com/${encodeURIComponent(postId)}`;
