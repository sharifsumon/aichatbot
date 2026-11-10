import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import type { FastifyPluginAsync } from 'fastify';
import type { Db } from '@agently/db';
import type { GraphClient } from '@agently/meta';
import type { ObjectStore } from '@agently/storage';
import type { CookieSettings } from '../auth/session.ts';
import { adminAuthRoutes } from './auth.ts';
import { adminConversationRoutes } from './conversations.ts';
import { adminInsightRoutes } from './insights.ts';
import { adminModelRoutes } from './models.ts';
import { adminPlatformRoutes } from './platform.ts';
import { adminSession } from './session.ts';
import { adminTenantRoutes } from './tenants.ts';
import type { AdminUser } from './session.ts';

export interface AdminDeps {
  db: Db;
  graph: Pick<GraphClient, 'sendText' | 'replyToComment'>;
  encryptionKey: string;
  cookies: CookieSettings;
  /** The admin panel's own address; requests that change things must come from it. */
  adminUrl: string;
  /** Model character photos; without it adding a model answers 503. */
  storage?: ObjectStore;
  publicFileUrl?: (key: string) => string;
}

/**
 * The super admin API at /admin. Separate from the shop dashboard: its own
 * cookie, its own users (platform_users) and two-factor sign-in. A shop
 * session is never accepted here.
 */
export const adminRoutes: FastifyPluginAsync<AdminDeps> = async (app, deps) => {
  const origin = new URL(deps.adminUrl).origin;
  await app.register(cors, { origin, credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] });

  // Cookies ride along on cross-site requests, so changes must come from the admin app itself.
  app.addHook('preHandler', async (req, reply) => {
    if (req.method !== 'GET' && req.method !== 'OPTIONS' && req.headers.origin !== origin) {
      return reply.code(403).send({ error: 'Bad origin' });
    }
  });

  // Model character photos.
  await app.register(multipart, { limits: { files: 1, fields: 5, fileSize: 10 * 1024 * 1024 } });

  const { prefix: _prefix, ...childDeps } = deps as AdminDeps & { prefix?: string };
  app.register(adminAuthRoutes, childDeps);

  // Everything else needs a verified (password + 2FA) session.
  app.register(async (secured) => {
    secured.decorateRequest('admin', null as unknown as AdminUser);
    secured.addHook('preHandler', async (req, reply) => {
      const admin = await adminSession(deps.db, req);
      if (!admin?.verified) return reply.code(401).send({ error: 'Not signed in' });
      req.admin = admin;
    });
    secured.register(adminTenantRoutes, childDeps);
    secured.register(adminConversationRoutes, childDeps);
    secured.register(adminInsightRoutes, childDeps);
    secured.register(adminPlatformRoutes, childDeps);
    secured.register(adminModelRoutes, childDeps);
  });
};
