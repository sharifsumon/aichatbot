import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyMetaSignature } from './signature.ts';
import { parsePageWebhook } from './webhook.ts';
import { splitText } from './graph.ts';

test('verifies the signature over the raw body', () => {
  const body = Buffer.from('{"object":"page"}');
  const sig = 'sha256=' + createHmac('sha256', 'secret').update(body).digest('hex');
  assert.equal(verifyMetaSignature(body, sig, 'secret'), true);
  assert.equal(verifyMetaSignature(body, sig, 'other'), false);
  assert.equal(verifyMetaSignature(Buffer.from('{"object":"page" }'), sig, 'secret'), false);
  assert.equal(verifyMetaSignature(body, undefined, 'secret'), false);
  assert.equal(verifyMetaSignature(body, 'sha256=abc', 'secret'), false);
});

test('parses messages and new comments, skipping echoes and the page itself', () => {
  const jobs = parsePageWebhook({
    object: 'page',
    entry: [
      {
        id: 'PAGE',
        time: 1761850000000,
        messaging: [
          { sender: { id: 'PSID' }, recipient: { id: 'PAGE' }, timestamp: 1761850000001, message: { mid: 'm1', text: 'দাম কত?' } },
          { sender: { id: 'PAGE' }, recipient: { id: 'PSID' }, timestamp: 1761850000002, message: { mid: 'm2', text: 'hi', is_echo: true } },
        ],
        changes: [
          { field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'c1', post_id: 'p1', message: 'price?', from: { id: 'U1', name: 'Rahim' }, created_time: 1761850000 } },
          { field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'c2', post_id: 'p1', message: 'inbox', from: { id: 'PAGE' } } },
          { field: 'feed', value: { item: 'comment', verb: 'edited', comment_id: 'c1', post_id: 'p1', from: { id: 'U1' } } },
        ],
      },
    ],
  });
  assert.equal(jobs.length, 2);
  assert.deepEqual(
    jobs.map((j) => [j.kind, j.externalId, j.senderExternalId, j.text]),
    [
      ['message', 'm1', 'PSID', 'দাম কত?'],
      ['comment', 'c1', 'U1', 'price?'],
    ],
  );
  assert.equal(jobs[1]!.timestamp, 1761850000000);
});

test('ignores non-page payloads', () => {
  assert.deepEqual(parsePageWebhook({ object: 'instagram', entry: [] }), []);
});

test('splits long text on word boundaries', () => {
  const parts = splitText('word '.repeat(1000), 2000);
  assert.ok(parts.every((p) => p.length <= 2000));
  assert.equal(parts.join(' ').split(' ').length, 1000);
});
