import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { authAccounts, dataDeletionRequests, users, type Db } from '@agently/db';

export interface DataDeletionDeps {
  db: Db;
  facebook: { parseSignedRequest(signed: string): { user_id: string } | null };
  urls: { api: string };
}

/**
 * Meta's required callbacks for people who remove the app from their
 * Facebook settings. user_id is the app-scoped id of the person who signed
 * in with Facebook (shop staff), not a customer.
 */
export const metaDataDeletionRoutes: FastifyPluginAsync<DataDeletionDeps> = async (app, { db, facebook, urls }) => {
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  const signedUser = (body: unknown) => {
    const signed = (body as { signed_request?: string } | undefined)?.signed_request;
    return signed ? facebook.parseSignedRequest(signed) : null;
  };

  /** Deletes the sign-in and stored token, and the user if Facebook was their only sign-in. */
  app.post('/data-deletion', async (req, reply) => {
    const data = signedUser(req.body);
    if (!data) return reply.code(400).send({ error: 'Invalid signed_request' });

    const code = randomBytes(12).toString('hex');
    const status = await db.transaction(async (tx) => {
      const account = await tx.query.authAccounts.findFirst({
        where: and(eq(authAccounts.provider, 'facebook'), eq(authAccounts.providerAccountId, data.user_id)),
      });
      if (account) {
        await tx.delete(authAccounts).where(eq(authAccounts.id, account.id));
        const others = await tx.query.authAccounts.findFirst({ where: eq(authAccounts.userId, account.userId) });
        // Memberships and sessions go with the user. Shops (and their customers' data) stay
        // until the shop itself is deleted, since other staff may run them.
        if (!others) await tx.delete(users).where(eq(users.id, account.userId));
      }
      const result = account ? ('completed' as const) : ('not_found' as const);
      await tx.insert(dataDeletionRequests).values({ confirmationCode: code, provider: 'facebook', providerAccountId: data.user_id, status: result });
      return result;
    });
    req.log.info({ status }, 'Data deletion request');
    return { url: `${urls.api}/webhooks/meta/data-deletion/${code}`, confirmation_code: code };
  });

  app.get<{ Params: { code: string } }>('/data-deletion/:code', async (req, reply) => {
    const row = await db.query.dataDeletionRequests.findFirst({ where: eq(dataDeletionRequests.confirmationCode, req.params.code) });
    if (!row) return reply.code(404).send({ error: 'Unknown confirmation code' });
    return {
      confirmation_code: row.confirmationCode,
      status: row.status === 'completed' ? 'Your Agently sign-in data has been deleted.' : 'We hold no data for this account.',
      requested_at: row.createdAt,
    };
  });

  /** Someone removed the app: forget their token so we stop using it. */
  app.post('/deauthorize', async (req, reply) => {
    const data = signedUser(req.body);
    if (!data) return reply.code(400).send({ error: 'Invalid signed_request' });
    await db
      .update(authAccounts)
      .set({ accessTokenEncrypted: null, tokenExpiresAt: null })
      .where(and(eq(authAccounts.provider, 'facebook'), eq(authAccounts.providerAccountId, data.user_id)));
    return reply.code(204).send();
  });
};
