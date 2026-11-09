import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { OpenAICompatibleProvider } from '@agently/ai';
import { grantMonthlyCredits } from '@agently/billing';
import { createDb } from '@agently/db';
import { GraphClient } from '@agently/meta';
import { QUEUES, jobIdFor, loadEnv, type InboundJob, type KnowledgeJob, type ReplyJob } from '@agently/shared';
import { S3Store } from '@agently/storage';
import type { WorkerDeps } from './deps.ts';
import { handleInbound } from './inbound.ts';
import { handleKnowledge, staleSheetSources } from './knowledge.ts';
import { handleReply } from './reply.ts';

const env = loadEnv('database', 'redis', 'crypto', 'meta', 'ai');
const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const { db, close: closeDb } = createDb(env.DATABASE_URL, { max: 20 });
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const replyQueue = new Queue<ReplyJob>(QUEUES.reply, { connection });
const knowledgeQueue = new Queue<KnowledgeJob>(QUEUES.knowledge, { connection });
const billingQueue = new Queue(QUEUES.billing, { connection });

const REPLY_ATTEMPTS = 4;
const SHEET_RESYNC_MS = 6 * 3600 * 1000;

// Storage is optional until it is configured; file sources fail with a clear message meanwhile.
const storage = process.env.S3_ENDPOINT
  ? (() => {
      const s = loadEnv('storage');
      return new S3Store({
        endpoint: s.S3_ENDPOINT,
        region: s.S3_REGION,
        bucket: s.S3_BUCKET,
        accessKeyId: s.S3_ACCESS_KEY_ID,
        secretAccessKey: s.S3_SECRET_ACCESS_KEY,
      });
    })()
  : undefined;

const deps: WorkerDeps = {
  db,
  log,
  encryptionKey: env.ENCRYPTION_KEY,
  pricing: { inputPerMTok: env.AI_INPUT_COST_PER_MTOK, outputPerMTok: env.AI_OUTPUT_COST_PER_MTOK },
  ai: new OpenAICompatibleProvider({
    baseUrl: env.AI_BASE_URL,
    apiKey: env.AI_API_KEY,
    chatModel: env.AI_CHAT_MODEL,
    embeddingModel: env.AI_EMBEDDING_MODEL,
    embeddingDimensions: env.AI_EMBEDDING_DIMENSIONS,
  }),
  graph: new GraphClient({ version: env.META_GRAPH_VERSION }),
  storage,
  enqueueReply: async (job) => {
    await replyQueue.add('reply', job, {
      jobId: jobIdFor('reply', job.messageId),
      // A short wait lets a burst of messages arrive, so the bot answers them together.
      delay: 1500,
      attempts: REPLY_ATTEMPTS,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 24 * 3600 },
      removeOnFail: { age: 7 * 24 * 3600 },
    });
  },
  enqueueKnowledge: async (job) => {
    // One sync per source per minute: repeated clicks merge, a later re-sync still runs.
    await knowledgeQueue.add('sync', job, {
      jobId: jobIdFor('kb', `${job.sourceId}-${Math.floor(Date.now() / 60_000)}`),
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: { age: 24 * 3600 },
      removeOnFail: { age: 7 * 24 * 3600 },
    });
  },
};

const workers = [
  new Worker<InboundJob>(QUEUES.inbound, (job) => handleInbound(deps, job.data), { connection, concurrency: 50 }),
  new Worker<ReplyJob>(
    QUEUES.reply,
    (job) => handleReply(deps, job.data, { finalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1) }),
    { connection, concurrency: 20 },
  ),
  new Worker<KnowledgeJob>(
    QUEUES.knowledge,
    async (job) => {
      // The scheduler job fans out one sync per stale Google Sheet.
      if (job.name === 'resync-sheets') {
        const stale = await staleSheetSources(deps, new Date(Date.now() - SHEET_RESYNC_MS));
        await Promise.all(stale.map((s) => deps.enqueueKnowledge(s)));
        return { queued: stale.length };
      }
      return handleKnowledge(deps, job.data, { finalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1) });
    },
    // Crawls and embeddings are slow and heavy; keep a few at a time.
    { connection, concurrency: 3 },
  ),
  // One at a time, so a month's credits are never granted twice.
  new Worker(QUEUES.billing, async () => ({ granted: await grantMonthlyCredits(db) }), { connection, concurrency: 1 }),
];

await knowledgeQueue.upsertJobScheduler('resync-sheets', { every: 3600 * 1000 }, { name: 'resync-sheets' });
// Hourly, so a new month's credits arrive within the hour and a missed run catches up.
await billingQueue.upsertJobScheduler('monthly-credits', { every: 3600 * 1000 }, { name: 'monthly-credits' });

for (const w of workers) {
  w.on('completed', (job, result) => log.info({ queue: w.name, jobId: job.id, result }, 'Job done'));
  w.on('failed', (job, err) => log.error({ queue: w.name, jobId: job?.id, err }, 'Job failed'));
}
log.info('Worker started');

const shutdown = async () => {
  await Promise.all(workers.map((w) => w.close()));
  await replyQueue.close();
  await knowledgeQueue.close();
  await billingQueue.close();
  connection.disconnect();
  await closeDb();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
