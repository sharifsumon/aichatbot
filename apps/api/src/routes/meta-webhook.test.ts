import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import type { InboundJob } from '@agently/shared';
import { metaWebhookRoutes } from './meta-webhook.ts';

async function setup() {
  const added: { name: string; data: InboundJob; jobId: string }[] = [];
  const app = Fastify();
  await app.register(metaWebhookRoutes, {
    prefix: '/webhooks/meta',
    meta: { appSecret: 'app-secret', verifyToken: 'verify-me' },
    inbound: {
      add: async (name, data, opts) => {
        added.push({ name, data, jobId: opts.jobId });
      },
    },
  });
  return { app, added };
}

const sign = (body: string, secret = 'app-secret') =>
  'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

const payload = JSON.stringify({
  object: 'page',
  entry: [
    {
      id: 'PAGE',
      time: 1,
      messaging: [{ sender: { id: 'PSID' }, recipient: { id: 'PAGE' }, timestamp: 1, message: { mid: 'm_abc:1', text: 'hi' } }],
    },
  ],
});

test('answers the subscription challenge only with the right token', async () => {
  const { app } = await setup();
  const ok = await app.inject({ url: '/webhooks/meta?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42' });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body, '42');
  const bad = await app.inject({ url: '/webhooks/meta?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42' });
  assert.equal(bad.statusCode, 403);
});

test('queues a signed message with a dedupe job id', async () => {
  const { app, added } = await setup();
  const res = await app.inject({
    method: 'POST',
    url: '/webhooks/meta',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(payload) },
    payload,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(added.length, 1);
  assert.equal(added[0]!.jobId, 'fb-m_abc_1');
  assert.equal(added[0]!.data.text, 'hi');
});

test('rejects a bad signature and queues nothing', async () => {
  const { app, added } = await setup();
  const res = await app.inject({
    method: 'POST',
    url: '/webhooks/meta',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(payload, 'wrong') },
    payload,
  });
  assert.equal(res.statusCode, 401);
  assert.equal(added.length, 0);
});
