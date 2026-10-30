import type { FastifyPluginAsync } from 'fastify';
import { parsePageWebhook, verifyMetaSignature, type PageWebhookPayload } from '@agently/meta';
import { jobIdFor, type InboundJob } from '@agently/shared';

export interface MetaWebhookDeps {
  inbound: {
    add(name: string, data: InboundJob, opts: { jobId: string } & Record<string, unknown>): Promise<unknown>;
  };
  meta: { appSecret: string; verifyToken: string };
}

/**
 * One endpoint for every connected page. It only checks, splits and queues;
 * the worker does the slow work, so Meta always gets its 200 well within its timeout.
 */
export const metaWebhookRoutes: FastifyPluginAsync<MetaWebhookDeps> = async (app, { inbound, meta }) => {
  // Keep the raw bytes: the signature is computed over them, not over re-serialised JSON.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  // Meta's one-time subscription check.
  app.get<{ Querystring: Record<string, string | undefined> }>('/', async (req, reply) => {
    const q = req.query;
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === meta.verifyToken) {
      return reply.type('text/plain').send(q['hub.challenge'] ?? '');
    }
    return reply.code(403).send();
  });

  app.post('/', async (req, reply) => {
    const raw = req.body as Buffer | undefined;
    if (!raw || !verifyMetaSignature(raw, req.headers['x-hub-signature-256'] as string | undefined, meta.appSecret)) {
      req.log.warn('Rejected Meta webhook with a bad signature');
      return reply.code(401).send();
    }

    let payload: PageWebhookPayload;
    try {
      payload = JSON.parse(raw.toString('utf8')) as PageWebhookPayload;
    } catch {
      return reply.code(400).send();
    }

    const jobs = parsePageWebhook(payload);
    // Meta retries deliveries, so the job id is the message or comment id:
    // BullMQ ignores an add whose id it has already seen.
    await Promise.all(
      jobs.map((job) =>
        inbound.add(job.kind, job, {
          jobId: jobIdFor('fb', job.externalId),
          attempts: 5,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: { age: 24 * 3600 },
          removeOnFail: { age: 7 * 24 * 3600 },
        }),
      ),
    );
    return reply.send('EVENT_RECEIVED');
  });
};
