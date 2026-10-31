import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { limitsFor } from '@agently/billing';
import { activities, agents, knowledgeChunks, knowledgeSources, type Db } from '@agently/db';
import type { KnowledgeJob } from '@agently/shared';
import { workspaceKey, type ObjectStore } from '@agently/storage';
import { ALL_ROLES, MANAGERS, isUuid, requireRole } from './guard.ts';
import { parseBody } from './validate.ts';

export interface KnowledgeDeps {
  db: Db;
  /** Queues a source for the worker to read, chunk and embed. */
  enqueueKnowledge: (job: KnowledgeJob) => Promise<void>;
  /** Uploaded files; when absent, file uploads answer 503. */
  storage?: ObjectStore;
}

export const MAX_KNOWLEDGE_FILE_BYTES = 20 * 1024 * 1024;

/** Extension → what we accept it as. The worker reads the type from the file name. */
const FILE_TYPES: Record<string, string[]> = {
  pdf: ['application/pdf'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  csv: ['text/csv', 'application/vnd.ms-excel', 'text/plain'],
  txt: ['text/plain'],
  md: ['text/markdown', 'text/plain'],
};

const webUrl = z
  .string()
  .trim()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), 'must start with http:// or https://');

const sourceBody = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), name: z.string().trim().min(1).max(200), content: z.string().trim().min(1).max(200_000) }),
  z.object({
    type: z.literal('qa'),
    name: z.string().trim().min(1).max(200),
    pairs: z
      .array(z.object({ question: z.string().trim().min(1).max(1000), answer: z.string().trim().min(1).max(5000) }))
      .min(1)
      .max(500),
  }),
  z.object({ type: z.literal('website'), name: z.string().trim().max(200).optional(), url: webUrl }),
  z.object({
    type: z.literal('sheet'),
    name: z.string().trim().max(200).optional(),
    url: webUrl.refine((u) => /^https:\/\/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]+/.test(u), 'must be a Google Sheets link'),
  }),
]);

const updateBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  content: z.string().trim().min(1).max(200_000).optional(),
  pairs: z
    .array(z.object({ question: z.string().trim().min(1).max(1000), answer: z.string().trim().min(1).max(5000) }))
    .min(1)
    .max(500)
    .optional(),
});

type Params = { workspaceId: string; sourceId: string };

/** Knowledge Base: files, text, Q&A, websites and Google Sheets the bot answers from. */
export const knowledgeRoutes: FastifyPluginAsync<KnowledgeDeps> = async (app, deps) => {
  const { db } = deps;

  app.get<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/knowledge', async (req, reply) => {
    if (!(await requireRole(db, req, reply, ALL_ROLES))) return reply;
    const { workspaceId } = req.params;
    const rows = await db
      .select({
        id: knowledgeSources.id,
        type: knowledgeSources.type,
        name: knowledgeSources.name,
        url: knowledgeSources.url,
        fileSizeBytes: knowledgeSources.fileSizeBytes,
        status: knowledgeSources.status,
        error: knowledgeSources.error,
        lastSyncedAt: knowledgeSources.lastSyncedAt,
        createdAt: knowledgeSources.createdAt,
        chunks: sql<number>`(select count(*)::int from ${knowledgeChunks} where ${knowledgeChunks.sourceId} = ${knowledgeSources.id})`,
      })
      .from(knowledgeSources)
      .where(eq(knowledgeSources.workspaceId, workspaceId))
      .orderBy(desc(knowledgeSources.createdAt));
    const [used, limitMb] = await Promise.all([usedBytes(db, workspaceId), limitMbFor(db, workspaceId)]);
    return { sources: rows, usage: { usedBytes: used, limitBytes: limitMb * 1024 * 1024 } };
  });

  app.get<{ Params: Params }>('/workspaces/:workspaceId/knowledge/:sourceId', async (req, reply) => {
    if (!(await requireRole(db, req, reply, ALL_ROLES))) return reply;
    const source = await findSource(db, req.params);
    if (!source) return reply.code(404).send({ error: 'Source not found' });
    const { fileKey: _key, ...rest } = source;
    return { source: { ...rest, pairs: source.type === 'qa' ? JSON.parse(source.content ?? '[]') : undefined } };
  });

  app.post<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/knowledge', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    const body = await parseBody(sourceBody, req.body, reply);
    if (!body) return reply;
    const { workspaceId } = req.params;

    const values =
      body.type === 'text'
        ? { type: body.type, name: body.name, content: body.content }
        : body.type === 'qa'
          ? { type: body.type, name: body.name, content: JSON.stringify(body.pairs) }
          : { type: body.type, name: body.name || body.url, url: body.url };

    const adding = values.content ? Buffer.byteLength(values.content) : 0;
    const over = await overLimit(db, workspaceId, adding);
    if (over) return reply.code(413).send({ error: over });

    const source = await insertSource(db, workspaceId, req.user.id, values);
    await deps.enqueueKnowledge({ workspaceId, sourceId: source.id });
    return reply.code(201).send({ source: publicSource(source) });
  });

  /** Upload a PDF, Excel, CSV or text file as a source. multipart/form-data with one `file`. */
  app.post<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/knowledge/files', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    if (!deps.storage) return reply.code(503).send({ error: 'File uploads are not set up yet' });
    if (!req.isMultipart()) return reply.code(415).send({ error: 'Send the file as multipart/form-data' });

    const file = await req.file({ limits: { fileSize: MAX_KNOWLEDGE_FILE_BYTES, files: 1 } });
    if (!file) return reply.code(400).send({ error: 'No file was sent' });
    const name = file.filename.trim().slice(0, 200) || 'file';
    const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
    if (!FILE_TYPES[ext]) {
      file.file.resume();
      return reply.code(415).send({ error: 'Upload a PDF, Excel (.xlsx), CSV or text file' });
    }
    const bytes = await file.toBuffer().catch((err: { code?: string }) => {
      if (err.code === 'FST_REQ_FILE_TOO_LARGE') return undefined;
      throw err;
    });
    if (!bytes || file.file.truncated) return reply.code(413).send({ error: 'Files can be at most 20 MB' });

    const { workspaceId } = req.params;
    const over = await overLimit(db, workspaceId, bytes.length);
    if (over) return reply.code(413).send({ error: over });

    const key = workspaceKey(workspaceId, 'knowledge', `${randomUUID()}.${ext}`);
    await deps.storage.put(key, bytes, FILE_TYPES[ext]![0]!);
    const source = await insertSource(db, workspaceId, req.user.id, { type: 'file', name, fileKey: key, fileSizeBytes: bytes.length });
    await deps.enqueueKnowledge({ workspaceId, sourceId: source.id });
    return reply.code(201).send({ source: publicSource(source) });
  });

  /** Edit a text or Q&A source; the bot re-learns it. */
  app.patch<{ Params: Params }>('/workspaces/:workspaceId/knowledge/:sourceId', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    const source = await findSource(db, req.params);
    if (!source) return reply.code(404).send({ error: 'Source not found' });
    const body = await parseBody(updateBody, req.body, reply);
    if (!body) return reply;

    let content: string | undefined;
    if (body.content !== undefined) {
      if (source.type !== 'text') return reply.code(400).send({ error: 'Only text sources have content to edit' });
      content = body.content;
    }
    if (body.pairs !== undefined) {
      if (source.type !== 'qa') return reply.code(400).send({ error: 'Only Q&A sources have questions to edit' });
      content = JSON.stringify(body.pairs);
    }
    if (content !== undefined) {
      const over = await overLimit(db, source.workspaceId, Buffer.byteLength(content) - Buffer.byteLength(source.content ?? ''));
      if (over) return reply.code(413).send({ error: over });
    }

    const [updated] = await db
      .update(knowledgeSources)
      .set({ name: body.name ?? source.name, ...(content !== undefined ? { content, status: 'queued' as const, error: null } : {}) })
      .where(eq(knowledgeSources.id, source.id))
      .returning();
    if (content !== undefined) await deps.enqueueKnowledge({ workspaceId: source.workspaceId, sourceId: source.id });
    return { source: publicSource(updated!) };
  });

  /** Read the source again, e.g. after the website or sheet changed. */
  app.post<{ Params: Params }>('/workspaces/:workspaceId/knowledge/:sourceId/resync', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    const source = await findSource(db, req.params);
    if (!source) return reply.code(404).send({ error: 'Source not found' });
    if (source.status === 'processing') return reply.code(409).send({ error: 'This source is being read right now' });
    const [updated] = await db.update(knowledgeSources).set({ status: 'queued', error: null }).where(eq(knowledgeSources.id, source.id)).returning();
    await deps.enqueueKnowledge({ workspaceId: source.workspaceId, sourceId: source.id });
    return reply.code(202).send({ source: publicSource(updated!) });
  });

  app.delete<{ Params: Params }>('/workspaces/:workspaceId/knowledge/:sourceId', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    const source = await findSource(db, req.params);
    if (!source) return reply.code(404).send({ error: 'Source not found' });
    // Chunks go with the source (on delete cascade), so the bot stops using it at once.
    await db.delete(knowledgeSources).where(eq(knowledgeSources.id, source.id));
    await db.insert(activities).values({
      workspaceId: source.workspaceId,
      type: 'knowledge.removed',
      text: `${source.name} removed from the knowledge base`,
      actorUserId: req.user.id,
      data: { sourceId: source.id },
    });
    if (source.fileKey && deps.storage) {
      // Best effort: a leftover object costs a little storage, never a wrong answer.
      await deps.storage.delete(source.fileKey).catch((err: unknown) => req.log.warn({ err, key: source.fileKey }, 'File delete failed'));
    }
    return reply.code(204).send();
  });
};

type NewSource = Pick<typeof knowledgeSources.$inferInsert, 'type' | 'name' | 'url' | 'content' | 'fileKey' | 'fileSizeBytes'>;

async function insertSource(db: Db, workspaceId: string, userId: string, values: NewSource) {
  return db.transaction(async (tx) => {
    const agent = await tx.query.agents.findFirst({ where: eq(agents.workspaceId, workspaceId), orderBy: agents.createdAt });
    const [source] = await tx
      .insert(knowledgeSources)
      .values({ ...values, workspaceId, agentId: agent?.id ?? null, status: 'queued' })
      .returning();
    await tx.insert(activities).values({
      workspaceId,
      type: 'knowledge.added',
      text: `${source!.name} added to the knowledge base`,
      actorUserId: userId,
      data: { sourceId: source!.id },
    });
    return source!;
  });
}

function publicSource(s: typeof knowledgeSources.$inferSelect) {
  return { id: s.id, type: s.type, name: s.name, url: s.url, fileSizeBytes: s.fileSizeBytes, status: s.status, error: s.error, lastSyncedAt: s.lastSyncedAt, createdAt: s.createdAt };
}

async function findSource(db: Db, p: Params) {
  if (!isUuid(p.sourceId)) return undefined;
  return db.query.knowledgeSources.findFirst({
    where: and(eq(knowledgeSources.id, p.sourceId), eq(knowledgeSources.workspaceId, p.workspaceId)),
  });
}

/**
 * What counts against the plan's knowledge base size: an uploaded file's
 * size, and for other sources the larger of what was typed and what was read.
 */
export async function usedBytes(db: Db, workspaceId: string): Promise<number> {
  const [row] = await db
    .select({
      bytes: sql<number>`coalesce(sum(case when ${knowledgeSources.type} = 'file' then coalesce(${knowledgeSources.fileSizeBytes}, 0)
        else greatest(coalesce(octet_length(${knowledgeSources.content}), 0),
          coalesce((select sum(octet_length(${knowledgeChunks.content})) from ${knowledgeChunks} where ${knowledgeChunks.sourceId} = ${knowledgeSources.id}), 0))
        end), 0)::bigint`.mapWith(Number),
    })
    .from(knowledgeSources)
    .where(eq(knowledgeSources.workspaceId, workspaceId));
  return row?.bytes ?? 0;
}

async function limitMbFor(db: Db, workspaceId: string): Promise<number> {
  return (await limitsFor(db, workspaceId)).knowledgeBaseMb;
}

/** An error message when adding `bytes` would go over the plan, else undefined. */
async function overLimit(db: Db, workspaceId: string, bytes: number): Promise<string | undefined> {
  if (bytes <= 0) return undefined;
  const [used, limitMb] = await Promise.all([usedBytes(db, workspaceId), limitMbFor(db, workspaceId)]);
  if (used + bytes <= limitMb * 1024 * 1024) return undefined;
  return `Your plan's knowledge base holds ${limitMb} MB and this would go over it. Remove a source or upgrade your plan.`;
}
