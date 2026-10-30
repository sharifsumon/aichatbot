import { and, eq, inArray, lt, or, isNull } from 'drizzle-orm';
import { AIProviderError } from '@agently/ai';
import { activities, knowledgeChunks, knowledgeSources } from '@agently/db';
import {
  ExtractError,
  chunkCsv,
  chunkFile,
  chunkPages,
  chunkQa,
  chunkText,
  crawlSite,
  googleSheetCsvUrl,
} from '@agently/knowledge';
import type { KnowledgeJob } from '@agently/shared';
import type { WorkerDeps } from './deps.ts';

/** Pages read per website crawl. Becomes a per-plan limit with billing. */
export const CRAWL_PAGE_LIMIT = 50;
/** A guard against one source filling the database; about 2 MB of text. */
const MAX_CHUNKS = 2000;
const EMBED_BATCH = 64;

type Source = typeof knowledgeSources.$inferSelect;

/**
 * Reads one knowledge source, splits it into chunks, embeds them and
 * replaces the source's old chunks. The status moves queued → processing →
 * ready, or failed with a message the shop owner can act on.
 */
export async function handleKnowledge(
  deps: WorkerDeps,
  job: KnowledgeJob,
  opts: { finalAttempt: boolean },
): Promise<'ready' | 'failed' | 'missing'> {
  const { db } = deps;
  const where = and(eq(knowledgeSources.id, job.sourceId), eq(knowledgeSources.workspaceId, job.workspaceId));
  const source = await db.query.knowledgeSources.findFirst({ where });
  if (!source) return 'missing';

  await db.update(knowledgeSources).set({ status: 'processing', error: null }).where(where);
  try {
    const chunks = await chunksFor(deps, source);
    if (chunks.length === 0) throw new ExtractError('No text was found in this source.');
    if (chunks.length > MAX_CHUNKS) {
      throw new ExtractError(`This source is too large (${chunks.length} sections; the limit is ${MAX_CHUNKS}). Split it into smaller files.`);
    }

    const vectors: number[][] = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      vectors.push(...(await deps.ai.embed(chunks.slice(i, i + EMBED_BATCH))));
    }

    await db.transaction(async (tx) => {
      await tx.delete(knowledgeChunks).where(eq(knowledgeChunks.sourceId, source.id));
      await tx.insert(knowledgeChunks).values(
        chunks.map((content, i) => ({
          workspaceId: source.workspaceId,
          sourceId: source.id,
          content,
          embedding: vectors[i]!,
          // A rough count is enough for limits and display.
          tokenCount: Math.ceil(content.length / 4),
        })),
      );
      await tx.update(knowledgeSources).set({ status: 'ready', error: null, lastSyncedAt: new Date() }).where(where);
      await tx.insert(activities).values({
        workspaceId: source.workspaceId,
        type: 'knowledge.ready',
        text: `${source.name} is ready (${chunks.length} sections)`,
        data: { sourceId: source.id },
      });
    });
    return 'ready';
  } catch (err) {
    const retryable = err instanceof AIProviderError ? err.retryable : !(err instanceof ExtractError);
    if (retryable && !opts.finalAttempt) throw err;
    deps.log.warn({ err, sourceId: source.id }, 'Knowledge source failed');
    const message = err instanceof ExtractError ? err.message : 'Something went wrong while reading this source. Try again later.';
    await db.update(knowledgeSources).set({ status: 'failed', error: message }).where(where);
    return 'failed';
  }
}

async function chunksFor(deps: WorkerDeps, source: Source): Promise<string[]> {
  const http = deps.http ?? {};
  switch (source.type) {
    case 'text':
      return chunkText(source.content ?? '');
    case 'qa': {
      let pairs: unknown;
      try {
        pairs = JSON.parse(source.content ?? '[]');
      } catch {
        throw new ExtractError('The Q&A pairs could not be read.');
      }
      if (!Array.isArray(pairs)) throw new ExtractError('The Q&A pairs could not be read.');
      return chunkQa(pairs.map((p) => ({ question: String(p?.question ?? ''), answer: String(p?.answer ?? '') })));
    }
    case 'file': {
      if (!source.fileKey) throw new ExtractError('The file is missing.');
      if (!deps.storage) throw new ExtractError('File storage is not set up yet.');
      const bytes = await deps.storage.get(source.fileKey);
      // The original file name carries the extension; the key may not.
      return chunkFile(bytes, /\.[a-z0-9]+$/i.test(source.name) ? source.name : source.fileKey);
    }
    case 'website': {
      if (!source.url) throw new ExtractError('The website address is missing.');
      const pages = await crawlSite(source.url, { maxPages: CRAWL_PAGE_LIMIT, fetch: http.fetch, checkHost: http.checkHost });
      return chunkPages(pages);
    }
    case 'sheet': {
      if (!source.url) throw new ExtractError('The Google Sheet link is missing.');
      const res = await (http.fetch ?? fetch)(googleSheetCsvUrl(source.url), { signal: AbortSignal.timeout(20_000) });
      // A private sheet answers with a sign-in page instead of CSV.
      if (!res.ok || (res.headers.get('content-type') ?? '').includes('text/html')) {
        throw new ExtractError('Could not open the sheet. Share it as "Anyone with the link can view".');
      }
      return chunkCsv(await res.text());
    }
  }
}

/** Google Sheets are re-read on a schedule so edits reach the bot. */
export async function staleSheetSources(deps: Pick<WorkerDeps, 'db'>, olderThan: Date): Promise<KnowledgeJob[]> {
  const rows = await deps.db
    .select({ workspaceId: knowledgeSources.workspaceId, sourceId: knowledgeSources.id })
    .from(knowledgeSources)
    .where(
      and(
        eq(knowledgeSources.type, 'sheet'),
        inArray(knowledgeSources.status, ['ready', 'failed']),
        or(isNull(knowledgeSources.lastSyncedAt), lt(knowledgeSources.lastSyncedAt, olderThan)),
      ),
    );
  return rows;
}
