import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import type { Db } from '@agently/db';
import type { FacebookApp, GraphClient } from '@agently/meta';
import type { KnowledgeJob } from '@agently/shared';
import type { ObjectStore } from '@agently/storage';
import type { CookieSettings } from './auth/session.ts';
import { facebookAuthRoutes } from './routes/auth-facebook.ts';
import { dashboardApiRoutes } from './routes/dashboard-api.ts';
import { healthRoutes, type HealthDeps } from './routes/health.ts';
import { metaDataDeletionRoutes } from './routes/meta-data-deletion.ts';
import { metaWebhookRoutes, type MetaWebhookDeps } from './routes/meta-webhook.ts';

export type ServerDeps = HealthDeps &
  MetaWebhookDeps & {
    db: Db;
    facebook: Pick<
      FacebookApp,
      'loginUrl' | 'exchangeCode' | 'me' | 'pages' | 'subscribePage' | 'unsubscribePage' | 'parseSignedRequest'
    >;
    graph: Pick<GraphClient, 'sendText' | 'replyToComment'>;
    encryptionKey: string;
    urls: { web: string; api: string };
    cookies: CookieSettings;
    enqueueKnowledge: (job: KnowledgeJob) => Promise<void>;
    /** Object storage for uploads; without it upload routes answer 503. */
    storage?: ObjectStore;
    /** Public URL for a stored key (product images). */
    publicFileUrl?: (key: string) => string;
  };

export function buildServer(deps: ServerDeps) {
  const app = Fastify({
    logger: process.env.NODE_ENV === 'test' ? false : { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  app.register(cookie);
  app.register(healthRoutes, deps);
  app.register(metaWebhookRoutes, { ...deps, prefix: '/webhooks/meta' });
  app.register(metaDataDeletionRoutes, { ...deps, prefix: '/webhooks/meta' });
  app.register(facebookAuthRoutes, deps);
  app.register(dashboardApiRoutes, { ...deps, prefix: '/api' });

  return app;
}
