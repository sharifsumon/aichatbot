import { randomUUID } from 'node:crypto';
import { asc, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { modelCharacters, type Db } from '@agently/db';
import type { ObjectStore } from '@agently/storage';
import { IMAGE_TYPES, looksLike } from '../routes/catalog.ts';
import { isUuid } from '../routes/guard.ts';
import { parseBody } from '../routes/validate.ts';
import { audit, requirePerm } from './guard.ts';

/** Model photos are larger than product photos: the try-on AI wants a sharp, full-length person. */
export const MAX_MODEL_IMAGE_BYTES = 10 * 1024 * 1024;

const gender = z.enum(['female', 'male']);
const patchBody = z
  .object({ name: z.string().trim().min(1).max(60), gender, active: z.boolean(), sortOrder: z.number().int().min(-1000).max(1000) })
  .partial()
  .strict();

export interface AdminModelDeps {
  db: Db;
  storage?: ObjectStore;
  publicFileUrl?: (key: string) => string;
}

/**
 * Model characters for "Generate product image with models": photos of men
 * and women the Agently team uploads once, shared with every shop. Super
 * admins (settings.manage) add and edit them; the rest of the team can look.
 */
export const adminModelRoutes: FastifyPluginAsync<AdminModelDeps> = async (app, deps) => {
  const { db } = deps;

  app.get('/models', async () => ({
    models: await db.select().from(modelCharacters).orderBy(asc(modelCharacters.sortOrder), desc(modelCharacters.createdAt)),
  }));

  /** multipart/form-data: `name` and `gender` fields first, then one `file` (JPEG, PNG or WebP, up to 10 MB). */
  app.post('/models', async (req, reply) => {
    if (!(await requirePerm(req, reply, 'settings.manage'))) return reply;
    if (!deps.storage || !deps.publicFileUrl) return reply.code(503).send({ error: 'Image uploads are not set up yet (S3 settings)' });
    if (!req.isMultipart()) return reply.code(415).send({ error: 'Send the photo as multipart/form-data' });
    const file = await req.file({ limits: { fileSize: MAX_MODEL_IMAGE_BYTES, files: 1 } });
    if (!file) return reply.code(400).send({ error: 'No photo was sent' });
    const field = (n: string) => {
      const f = file.fields[n];
      return f && !Array.isArray(f) && f.type === 'field' ? String(f.value) : undefined;
    };
    const meta = z.object({ name: z.string().trim().min(1).max(60), gender }).safeParse({ name: field('name'), gender: field('gender') });
    const ext = IMAGE_TYPES[file.mimetype];
    if (!meta.success || !ext) {
      file.file.resume();
      return reply.code(400).send({ error: !meta.success ? 'Give the model a name and choose female or male' : 'Upload a JPEG, PNG or WebP photo' });
    }
    const bytes = await file.toBuffer().catch((err: { code?: string }) => {
      if (err.code === 'FST_REQ_FILE_TOO_LARGE') return undefined;
      throw err;
    });
    if (!bytes || file.file.truncated) return reply.code(413).send({ error: 'A model photo can be at most 10 MB' });
    if (!looksLike(ext, bytes)) return reply.code(415).send({ error: 'That file is not a JPEG, PNG or WebP image' });

    const key = `platform/models/${randomUUID()}.${ext}`;
    await deps.storage.put(key, bytes, file.mimetype);
    const [model] = await db
      .insert(modelCharacters)
      .values({ ...meta.data, imageUrl: deps.publicFileUrl(key), imageKey: key, createdByPlatformUserId: req.admin.id })
      .returning();
    await audit(db, req, 'model.created', { targetType: 'model_character', targetId: model!.id, data: meta.data });
    return reply.code(201).send({ model });
  });

  app.patch<{ Params: { modelId: string } }>('/models/:modelId', async (req, reply) => {
    if (!(await requirePerm(req, reply, 'settings.manage'))) return reply;
    if (!isUuid(req.params.modelId)) return reply.code(404).send({ error: 'Model not found' });
    const body = await parseBody(patchBody, req.body, reply);
    if (!body) return reply;
    const [model] = await db.update(modelCharacters).set(body).where(eq(modelCharacters.id, req.params.modelId)).returning();
    if (!model) return reply.code(404).send({ error: 'Model not found' });
    await audit(db, req, 'model.updated', { targetType: 'model_character', targetId: model.id, data: body });
    return { model };
  });

  /** Deletes the model and its photo. Images already made with it stay in the shops' catalogs. */
  app.delete<{ Params: { modelId: string } }>('/models/:modelId', async (req, reply) => {
    if (!(await requirePerm(req, reply, 'settings.manage'))) return reply;
    if (!isUuid(req.params.modelId)) return reply.code(404).send({ error: 'Model not found' });
    const [model] = await db.delete(modelCharacters).where(eq(modelCharacters.id, req.params.modelId)).returning();
    if (!model) return reply.code(404).send({ error: 'Model not found' });
    if (model.imageKey && deps.storage) await deps.storage.delete(model.imageKey).catch((err: unknown) => req.log.warn({ err }, 'Model photo delete failed'));
    await audit(db, req, 'model.deleted', { targetType: 'model_character', targetId: model.id, data: { name: model.name } });
    return reply.code(204).send();
  });
};
