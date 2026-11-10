import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, lt, sql } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { GARMENT_CATEGORIES, TryOnError, type TryOnProvider } from '@agently/ai';
import { creditsRemaining, recordUsage } from '@agently/billing';
import { modelCharacters, platformSettings, tryOnImages, type Db } from '@agently/db';
import { workspaceKey, type ObjectStore } from '@agently/storage';
import { ALL_ROLES, MANAGERS, isUuid, requireRole } from './guard.ts';
import { parseBody } from './validate.ts';

export interface TryOnDeps {
  db: Db;
  storage?: ObjectStore;
  publicFileUrl?: (key: string) => string;
  /** The try-on AI; without it generating answers 503. */
  tryOn?: TryOnProvider;
}

/** Credits one image uses when the super admin has not set tryon.creditsPerImage. */
export const DEFAULT_TRYON_CREDITS = 10;
/** A shop can have this many images being made at once. */
const MAX_RUNNING = 3;
/** A run still pending after this long was lost (the API restarted); it shows as failed. */
const STALE_MS = 5 * 60_000;
const RUN_TIMEOUT_MS = 4 * 60_000;

const generateBody = z.object({
  characterId: z.string().uuid(),
  /** A photo uploaded with POST /uploads/images. */
  garmentImageUrl: z.string().url(),
  category: z.enum(GARMENT_CATEGORIES as [string, ...string[]]).default('auto'),
  note: z.string().trim().max(300).optional(),
});

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export async function creditsPerTryOn(db: Db): Promise<number> {
  const row = await db.query.platformSettings.findFirst({ where: eq(platformSettings.key, 'tryon.creditsPerImage') });
  return typeof row?.value === 'number' ? row.value : DEFAULT_TRYON_CREDITS;
}

/**
 * "Generate product image with models": the shop picks one of the platform's
 * model characters and uploads a garment photo; the try-on AI makes a photo of
 * the model wearing it, which the shop can add to a product.
 */
export const tryOnRoutes: FastifyPluginAsync<TryOnDeps> = async (app, deps) => {
  const { db } = deps;

  /** The model characters to choose from, and whether generating is switched on. */
  app.get<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/try-on/models', async (req, reply) => {
    if (!(await requireRole(db, req, reply, ALL_ROLES))) return reply;
    const models = await db
      .select({ id: modelCharacters.id, name: modelCharacters.name, gender: modelCharacters.gender, imageUrl: modelCharacters.imageUrl })
      .from(modelCharacters)
      .where(eq(modelCharacters.active, true))
      .orderBy(asc(modelCharacters.sortOrder), desc(modelCharacters.createdAt));
    return {
      models,
      enabled: !!(deps.tryOn && deps.storage && deps.publicFileUrl),
      creditsPerImage: await creditsPerTryOn(db),
    };
  });

  /** The shop's recent images, newest first. */
  app.get<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/try-on', async (req, reply) => {
    if (!(await requireRole(db, req, reply, ALL_ROLES))) return reply;
    await failStale(db, req.params.workspaceId);
    const images = await db
      .select()
      .from(tryOnImages)
      .where(eq(tryOnImages.workspaceId, req.params.workspaceId))
      .orderBy(desc(tryOnImages.createdAt))
      .limit(40);
    return { images: images.map(view) };
  });

  app.get<{ Params: { workspaceId: string; imageId: string } }>('/workspaces/:workspaceId/try-on/:imageId', async (req, reply) => {
    if (!(await requireRole(db, req, reply, ALL_ROLES))) return reply;
    if (!isUuid(req.params.imageId)) return reply.code(404).send({ error: 'Image not found' });
    await failStale(db, req.params.workspaceId);
    const image = await db.query.tryOnImages.findFirst({
      where: and(eq(tryOnImages.id, req.params.imageId), eq(tryOnImages.workspaceId, req.params.workspaceId)),
    });
    if (!image) return reply.code(404).send({ error: 'Image not found' });
    return { image: view(image) };
  });

  /** Starts making an image. Answers at once with a pending image; poll it until it succeeds or fails. */
  app.post<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/try-on', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    const { tryOn, storage, publicFileUrl } = deps;
    if (!tryOn || !storage || !publicFileUrl) return reply.code(503).send({ error: 'Product images with models are not switched on yet' });
    const body = await parseBody(generateBody, req.body, reply);
    if (!body) return reply;
    const { workspaceId } = req.params;

    // Only this shop's own uploads: the API reads the file from storage, never from the web.
    const prefix = publicFileUrl(workspaceKey(workspaceId, 'images', ''));
    const name = body.garmentImageUrl.startsWith(prefix) ? body.garmentImageUrl.slice(prefix.length) : '';
    if (!/^[A-Za-z0-9-]+\.(jpg|png|webp)$/.test(name)) return reply.code(400).send({ error: 'Upload the garment photo here first' });
    const garmentKey = workspaceKey(workspaceId, 'images', name);

    const character = await db.query.modelCharacters.findFirst({ where: and(eq(modelCharacters.id, body.characterId), eq(modelCharacters.active, true)) });
    if (!character?.imageKey) return reply.code(404).send({ error: 'That model is no longer available' });

    const cost = await creditsPerTryOn(db);
    if (cost > 0 && (await creditsRemaining(db, workspaceId)) < cost) {
      return reply.code(402).send({ error: `Making an image uses ${cost} AI credits, and this month's credits are used up. Top up or upgrade to make more.`, limit: 'credits' });
    }
    await failStale(db, workspaceId);
    const [running] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(tryOnImages)
      .where(and(eq(tryOnImages.workspaceId, workspaceId), eq(tryOnImages.status, 'pending')));
    if ((running?.n ?? 0) >= MAX_RUNNING) return reply.code(429).send({ error: `${MAX_RUNNING} images are already being made. Wait for one to finish.` });

    const [image] = await db
      .insert(tryOnImages)
      .values({
        workspaceId,
        characterId: character.id,
        modelImageUrl: character.imageUrl,
        garmentImageUrl: body.garmentImageUrl,
        category: body.category,
        provider: tryOn.name,
        model: tryOn.model,
        createdByUserId: req.user.id,
      })
      .returning();

    // In the background, so a slow AI never holds the request past the proxy's timeout.
    void run({ db, storage, publicFileUrl, tryOn, log: req.log }, image!.id, workspaceId, {
      modelKey: character.imageKey,
      garmentKey,
      category: body.category as (typeof GARMENT_CATEGORIES)[number],
      note: body.note,
      credits: cost,
    });
    return reply.code(202).send({ image: view(image!) });
  });

  /** Removes an image from the list. A copy already added to a product stays there. */
  app.delete<{ Params: { workspaceId: string; imageId: string } }>('/workspaces/:workspaceId/try-on/:imageId', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    if (!isUuid(req.params.imageId)) return reply.code(404).send({ error: 'Image not found' });
    const [gone] = await db
      .delete(tryOnImages)
      .where(and(eq(tryOnImages.id, req.params.imageId), eq(tryOnImages.workspaceId, req.params.workspaceId)))
      .returning({ id: tryOnImages.id });
    if (!gone) return reply.code(404).send({ error: 'Image not found' });
    return reply.code(204).send();
  });
};

/** Makes the image and saves the result. Never throws: failures are written to the row. */
export async function run(
  deps: { db: Db; storage: ObjectStore; publicFileUrl: (key: string) => string; tryOn: TryOnProvider; log: FastifyBaseLogger },
  imageId: string,
  workspaceId: string,
  job: { modelKey: string; garmentKey: string; category: (typeof GARMENT_CATEGORIES)[number]; note?: string; credits: number },
): Promise<void> {
  const { db, storage, tryOn } = deps;
  const usageModel = `tryon:${tryOn.model}`;
  try {
    const [modelBytes, garmentBytes] = await Promise.all([storage.get(job.modelKey), storage.get(job.garmentKey)]);
    const result = await tryOn.tryOn(
      {
        model: { bytes: modelBytes, contentType: typeOf(job.modelKey) },
        garment: { bytes: garmentBytes, contentType: typeOf(job.garmentKey) },
        category: job.category,
        note: job.note,
      },
      AbortSignal.timeout(RUN_TIMEOUT_MS),
    );
    const key = workspaceKey(workspaceId, 'images', `${randomUUID()}.${EXT[result.image.contentType] ?? 'png'}`);
    await storage.put(key, result.image.bytes, result.image.contentType);
    await db
      .update(tryOnImages)
      .set({ status: 'succeeded', resultImageUrl: deps.publicFileUrl(key), costUsd: result.costUsd.toFixed(6), finishedAt: new Date() })
      .where(eq(tryOnImages.id, imageId));
    await recordUsage(db, { workspaceId, model: usageModel, aiReplies: job.credits, inputTokens: 0, outputTokens: 0, costUsd: result.costUsd });
  } catch (err) {
    deps.log.warn({ err, imageId }, 'Try-on failed');
    const message = err instanceof TryOnError ? err.userMessage : 'Something went wrong making this image. Try again.';
    await db
      .update(tryOnImages)
      .set({ status: 'failed', error: message, finishedAt: new Date() })
      .where(eq(tryOnImages.id, imageId))
      .catch(() => undefined);
    await recordUsage(db, { workspaceId, model: usageModel, aiReplies: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, failed: true }).catch(() => undefined);
  }
}

function typeOf(key: string): string {
  if (key.endsWith('.png')) return 'image/png';
  if (key.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

async function failStale(db: Db, workspaceId: string) {
  await db
    .update(tryOnImages)
    .set({ status: 'failed', error: 'This image was interrupted. Try again.', finishedAt: new Date() })
    .where(and(eq(tryOnImages.workspaceId, workspaceId), eq(tryOnImages.status, 'pending'), lt(tryOnImages.createdAt, new Date(Date.now() - STALE_MS))));
}

function view(i: typeof tryOnImages.$inferSelect) {
  return {
    id: i.id,
    characterId: i.characterId,
    modelImageUrl: i.modelImageUrl,
    garmentImageUrl: i.garmentImageUrl,
    category: i.category,
    status: i.status,
    resultImageUrl: i.resultImageUrl,
    error: i.error,
    createdAt: i.createdAt,
    finishedAt: i.finishedAt,
  };
}
