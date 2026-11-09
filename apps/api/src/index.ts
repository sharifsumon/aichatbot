import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { createDb } from '@agently/db';
import { FacebookApp, GraphClient } from '@agently/meta';
import { QUEUES, jobIdFor, loadEnv, type InboundJob, type KnowledgeJob } from '@agently/shared';
import { DiskStore, storageFromEnv } from '@agently/storage';
import { buildServer } from './server.ts';

const env = loadEnv('database', 'redis', 'meta', 'crypto', 'urls');
const { db, close: closeDb } = createDb(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const inbound = new Queue<InboundJob>(QUEUES.inbound, { connection: redis });
const knowledge = new Queue<KnowledgeJob>(QUEUES.knowledge, { connection: redis });

// Uploads are optional in development; the routes answer 503 without storage.
// An S3 bucket when S3_ENDPOINT is set, otherwise the server's disk (FILES_DIR).
const storage = storageFromEnv(process.env);
const s3Public = process.env.S3_PUBLIC_URL?.replace(/\/+$/, '');
// Disk files are served by the API itself at /files/<key>.
const publicBase = storage instanceof DiskStore ? `${env.API_URL.replace(/\/+$/, '')}/files` : s3Public || undefined;

const app = buildServer({
  db,
  redis,
  inbound,
  meta: { appSecret: env.META_APP_SECRET, verifyToken: env.META_VERIFY_TOKEN },
  facebook: new FacebookApp({ appId: env.META_APP_ID, appSecret: env.META_APP_SECRET, version: env.META_GRAPH_VERSION }),
  graph: new GraphClient({ version: env.META_GRAPH_VERSION }),
  encryptionKey: env.ENCRYPTION_KEY,
  urls: { web: env.WEB_URL, api: env.API_URL, admin: env.ADMIN_URL || undefined },
  cookies: { secure: env.API_URL.startsWith('https://'), domain: env.COOKIE_DOMAIN || undefined },
  storage,
  diskFiles: storage instanceof DiskStore ? storage : undefined,
  publicFileUrl: publicBase ? (key) => `${publicBase}/${key}` : undefined,
  enqueueKnowledge: async (job) => {
    // Same job id as the worker's scheduler uses: repeated clicks in a minute merge.
    await knowledge.add('sync', job, {
      jobId: jobIdFor('kb', `${job.sourceId}-${Math.floor(Date.now() / 60_000)}`),
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: { age: 24 * 3600 },
      removeOnFail: { age: 7 * 24 * 3600 },
    });
  },
});

const shutdown = async () => {
  await app.close();
  await Promise.all([inbound.close(), knowledge.close()]);
  redis.disconnect();
  await closeDb();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 4000) });
