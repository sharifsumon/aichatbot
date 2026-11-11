import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { GARMENT_CATEGORIES, TRYON_STYLES, TryOnError, type TryOnProvider, type TryOnStyle } from '@agently/ai';
import { creditsRemaining, recordUsage } from '@agently/billing';
import { modelCharacters, platformSettings, tryOnImages, type Db } from '@agently/db';
import { workspaceKey, type ObjectStore } from '@agently/storage';
import { ALL_ROLES, MANAGERS, isUuid, requireRole } from './guard.ts';
import { parseBody } from './validate.ts';
import { currentTryOn } from './tryon-service.ts';

export interface TryOnDeps {
  db: Db;
  storage?: ObjectStore;
  publicFileUrl?: (key: string) => string;
  /** The try-on AI from the server's .env; the super admin's settings override it. */
  tryOn?: TryOnProvider;
  /** Decrypts the API key saved in Platform settings. */
  encryptionKey: string;
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
  pose: z.enum(Object.keys(TRYON_STYLES.pose) as [string, ...string[]]).optional(),
  expression: z.enum(Object.keys(TRYON_STYLES.expression) as [string, ...string[]]).optional(),
  camera: z.enum(Object.keys(TRYON_STYLES.camera) as [string, ...string[]]).optional(),
  background: z.enum(Object.keys(TRYON_STYLES.background) as [string, ...string[]]).optional(),
  /** The shop's own instructions for the photo. */
  note: z.string().trim().max(500).optional(),
});

const ownModelBody = z.object({
  name: z.string().trim().min(1).max(60),
  gender: z.enum(['female', 'male']),
  /** A photo uploaded with POST /uploads/images. */
  imageUrl: z.string().url(),
});
/** How many of its own models a shop can keep. */
const MAX_OWN_MODELS = 30;

/** The platform's models plus this shop's own. */
const visibleTo = (workspaceId: string) => and(eq(modelCharacters.active, true), or(isNull(modelCharacters.workspaceId), eq(modelCharacters.workspaceId, workspaceId)));

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
      .select({ id: modelCharacters.id, name: modelCharacters.name, gender: modelCharacters.gender, imageUrl: modelCharacters.imageUrl, workspaceId: modelCharacters.workspaceId })
      .from(modelCharacters)
      .where(visibleTo(req.params.workspaceId))
      // The shop's own models first, newest first.
      .orderBy(sql`${modelCharacters.workspaceId} is null`, asc(modelCharacters.sortOrder), desc(modelCharacters.createdAt));
    const tryOn = await currentTryOn(db, deps.encryptionKey, deps.tryOn).catch(() => undefined);
    return {
      models: models.map(({ workspaceId, ...m }) => ({ ...m, own: !!workspaceId })),
      enabled: !!(tryOn && deps.storage && deps.publicFileUrl),
      creditsPerImage: await creditsPerTryOn(db),
      /** FASHN makes try-ons only; pose, expression, background and instructions need an image model (fal.ai, Gemini). */
      styleOptions: tryOn ? tryOn.name !== 'fashn' : true,
    };
  });

  /** Adds the shop's own model from a photo uploaded with POST /uploads/images. Only this shop sees it. */
  app.post<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/try-on/models', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    if (!deps.publicFileUrl) return reply.code(503).send({ error: 'Photo uploads are not switched on yet' });
    const body = await parseBody(ownModelBody, req.body, reply);
    if (!body) return reply;
    const { workspaceId } = req.params;
    const prefix = deps.publicFileUrl(workspaceKey(workspaceId, 'images', ''));
    const name = body.imageUrl.startsWith(prefix) ? body.imageUrl.slice(prefix.length) : '';
    if (!/^[A-Za-z0-9-]+\.(jpg|png|webp)$/.test(name)) return reply.code(400).send({ error: 'Upload the model photo here first' });
    const [count] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(modelCharacters)
      .where(eq(modelCharacters.workspaceId, workspaceId));
    if ((count?.n ?? 0) >= MAX_OWN_MODELS) return reply.code(400).send({ error: `You can keep up to ${MAX_OWN_MODELS} of your own models. Remove one first.` });
    const [model] = await db
      .insert(modelCharacters)
      .values({ workspaceId, name: body.name, gender: body.gender, imageUrl: body.imageUrl, imageKey: workspaceKey(workspaceId, 'images', name) })
      .returning({ id: modelCharacters.id, name: modelCharacters.name, gender: modelCharacters.gender, imageUrl: modelCharacters.imageUrl });
    return reply.code(201).send({ model: { ...model, own: true } });
  });

  /** Removes one of the shop's own models. Images already made with it stay. */
  app.delete<{ Params: { workspaceId: string; modelId: string } }>('/workspaces/:workspaceId/try-on/models/:modelId', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    if (!isUuid(req.params.modelId)) return reply.code(404).send({ error: 'Model not found' });
    const [gone] = await db
      .delete(modelCharacters)
      .where(and(eq(modelCharacters.id, req.params.modelId), eq(modelCharacters.workspaceId, req.params.workspaceId)))
      .returning({ id: modelCharacters.id });
    if (!gone) return reply.code(404).send({ error: 'Model not found' });
    return { ok: true };
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
    const { storage, publicFileUrl } = deps;
    let tryOn: TryOnProvider | undefined;
    try {
      tryOn = await currentTryOn(db, deps.encryptionKey, deps.tryOn);
    } catch (err) {
      req.log.error({ err }, 'Try-on settings unreadable');
      return reply.code(503).send({ error: 'Product images with models are not set up correctly. Ask Agently support.' });
    }
    if (!tryOn || !storage || !publicFileUrl) return reply.code(503).send({ error: 'Product images with models are not switched on yet' });
    const body = await parseBody(generateBody, req.body, reply);
    if (!body) return reply;
    const { workspaceId } = req.params;

    // Only this shop's own uploads: the API reads the file from storage, never from the web.
    const prefix = publicFileUrl(workspaceKey(workspaceId, 'images', ''));
    const name = body.garmentImageUrl.startsWith(prefix) ? body.garmentImageUrl.slice(prefix.length) : '';
    if (!/^[A-Za-z0-9-]+\.(jpg|png|webp)$/.test(name)) return reply.code(400).send({ error: 'Upload the garment photo here first' });
    const garmentKey = workspaceKey(workspaceId, 'images', name);

    const character = await db.query.modelCharacters.findFirst({ where: and(eq(modelCharacters.id, body.characterId), visibleTo(workspaceId)) });
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
      modelUrl: character.imageUrl,
      garmentKey,
      garmentUrl: body.garmentImageUrl,
      category: body.category as (typeof GARMENT_CATEGORIES)[number],
      style: { pose: body.pose, expression: body.expression, camera: body.camera, background: body.background } as TryOnStyle,
      note: body.note || undefined,
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
  job: { modelKey: string; modelUrl?: string; garmentKey: string; garmentUrl?: string; category: (typeof GARMENT_CATEGORIES)[number]; style?: TryOnStyle; note?: string; credits: number },
): Promise<void> {
  const { db, storage, tryOn } = deps;
  const usageModel = `tryon:${tryOn.model}`;
  try {
    const [modelBytes, garmentBytes] = await Promise.all([storage.get(job.modelKey), storage.get(job.garmentKey)]);
    const result = await tryOn.tryOn(
      {
        model: { bytes: modelBytes, contentType: typeOf(job.modelKey), url: job.modelUrl },
        garment: { bytes: garmentBytes, contentType: typeOf(job.garmentKey), url: job.garmentUrl },
        category: job.category,
        style: job.style,
        note: job.note,
      },
      AbortSignal.timeout(RUN_TIMEOUT_MS),
    );
    const key = workspaceKey(workspaceId, 'images', `${randomUUID()}.${EXT[result.image.contentType] ?? 'png'}`);
    await storage.put(key, result.image.bytes, result.image.contentType);
    // Usage is recorded before the status changes, so whoever sees the result also sees the charge.
    await recordUsage(db, { workspaceId, model: usageModel, aiReplies: job.credits, inputTokens: 0, outputTokens: 0, costUsd: result.costUsd });
    await db
      .update(tryOnImages)
      .set({ status: 'succeeded', resultImageUrl: deps.publicFileUrl(key), costUsd: result.costUsd.toFixed(6), finishedAt: new Date() })
      .where(eq(tryOnImages.id, imageId));
  } catch (err) {
    deps.log.warn({ err, imageId }, 'Try-on failed');
    const message = err instanceof TryOnError ? err.userMessage : 'Something went wrong making this image. Try again.';
    await recordUsage(db, { workspaceId, model: usageModel, aiReplies: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, failed: true }).catch(() => undefined);
    await db
      .update(tryOnImages)
      .set({ status: 'failed', error: message, finishedAt: new Date() })
      .where(eq(tryOnImages.id, imageId))
      .catch(() => undefined);
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
