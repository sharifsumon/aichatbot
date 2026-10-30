import Fastify from 'fastify';
import type { Db } from '@agently/db';
import { healthRoutes, type HealthDeps } from './routes/health.ts';
import { metaWebhookRoutes, type MetaWebhookDeps } from './routes/meta-webhook.ts';

export type ServerDeps = HealthDeps & MetaWebhookDeps & { db: Db };

export function buildServer(deps: ServerDeps) {
  const app = Fastify({
    logger: process.env.NODE_ENV === 'test' ? false : { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  app.register(healthRoutes, deps);
  app.register(metaWebhookRoutes, { ...deps, prefix: '/webhooks/meta' });

  return app;
}
