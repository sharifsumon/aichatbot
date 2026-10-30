import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import type { Db } from '@agently/db';
import type { FacebookApp } from '@agently/meta';
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
    encryptionKey: string;
    urls: { web: string; api: string };
    cookies: CookieSettings;
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
