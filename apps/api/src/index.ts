import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { createDb } from '@agently/db';
import { QUEUES, loadEnv, type InboundJob } from '@agently/shared';
import { buildServer } from './server.ts';

const env = loadEnv('database', 'redis', 'meta');
const { db, close: closeDb } = createDb(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const inbound = new Queue<InboundJob>(QUEUES.inbound, { connection: redis });

const app = buildServer({ db, redis, inbound, meta: { appSecret: env.META_APP_SECRET, verifyToken: env.META_VERIFY_TOKEN } });

const shutdown = async () => {
  await app.close();
  await inbound.close();
  redis.disconnect();
  await closeDb();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 4000) });
