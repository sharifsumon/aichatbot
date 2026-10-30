import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import type { Db } from '@agently/db';

export interface HealthDeps {
  db: Pick<Db, 'execute'>;
  redis: { ping(): Promise<string> };
}

export const healthRoutes: FastifyPluginAsync<HealthDeps> = async (app, { db, redis }) => {
  app.get('/health', async (_req, reply) => {
    const [database, queue] = await Promise.all([
      db.execute(sql`select 1`).then(() => true, () => false),
      redis.ping().then(() => true, () => false),
    ]);
    const ok = database && queue;
    return reply.code(ok ? 200 : 503).send({ ok, database, redis: queue });
  });
};
