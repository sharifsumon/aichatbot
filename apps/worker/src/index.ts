import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { OpenAICompatibleProvider } from '@agently/ai';
import { createDb } from '@agently/db';
import { GraphClient } from '@agently/meta';
import { QUEUES, jobIdFor, loadEnv, type InboundJob, type ReplyJob } from '@agently/shared';
import type { WorkerDeps } from './deps.ts';
import { handleInbound } from './inbound.ts';
import { handleReply } from './reply.ts';

const env = loadEnv('database', 'redis', 'crypto', 'meta', 'ai');
const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const { db, close: closeDb } = createDb(env.DATABASE_URL, { max: 20 });
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const replyQueue = new Queue<ReplyJob>(QUEUES.reply, { connection });

const REPLY_ATTEMPTS = 4;

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
};

const workers = [
  new Worker<InboundJob>(QUEUES.inbound, (job) => handleInbound(deps, job.data), { connection, concurrency: 50 }),
  new Worker<ReplyJob>(
    QUEUES.reply,
    (job) => handleReply(deps, job.data, { finalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1) }),
    { connection, concurrency: 20 },
  ),
];

for (const w of workers) {
  w.on('completed', (job, result) => log.info({ queue: w.name, jobId: job.id, result }, 'Job done'));
  w.on('failed', (job, err) => log.error({ queue: w.name, jobId: job?.id, err }, 'Job failed'));
}
log.info('Worker started');

const shutdown = async () => {
  await Promise.all(workers.map((w) => w.close()));
  await replyQueue.close();
  connection.disconnect();
  await closeDb();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
