import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { createDb } from '@agently/db';
import { FacebookApp, GraphClient } from '@agently/meta';
import { QUEUES, jobIdFor, loadEnv, type InboundJob, type KnowledgeJob } from '@agently/shared';
import { S3Store } from '@agently/storage';
import { buildServer } from './server.ts';

const env = loadEnv('database', 'redis', 'meta', 'crypto', 'urls');
const { db, close: closeDb } = createDb(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const inbound = new Queue<InboundJob>(QUEUES.inbound, { connection: redis });
const knowledge = new Queue<KnowledgeJob>(QUEUES.knowledge, { connection: redis });

// Uploads are optional in development; the routes answer 503 without storage.
const storageEnv = process.env.S3_ENDPOINT ? loadEnv('storage') : undefined;
const storage = storageEnv
  ? new S3Store({
      endpoint: storageEnv.S3_ENDPOINT,
      region: storageEnv.S3_REGION,
      bucket: storageEnv.S3_BUCKET,
      accessKeyId: storageEnv.S3_ACCESS_KEY_ID,
      secretAccessKey: storageEnv.S3_SECRET_ACCESS_KEY,
    })
  : undefined;
const publicBase = storageEnv?.S3_PUBLIC_URL?.replace(/\/+$/, '');

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
