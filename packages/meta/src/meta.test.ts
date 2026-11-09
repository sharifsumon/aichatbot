import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyMetaSignature } from './signature.ts';
import { parsePageWebhook } from './webhook.ts';
import { GraphApiError, GraphClient, splitText } from './graph.ts';

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

test('m.me links: the ref arrives with Get Started for a new chat, or as a referral', () => {
  const jobs = parsePageWebhook({
    object: 'page',
    entry: [
      {
        id: 'PAGE',
        time: 1,
        messaging: [
          { sender: { id: 'NEW' }, recipient: { id: 'PAGE' }, timestamp: 10, postback: { mid: 'pb1', title: 'Get Started', payload: 'GET_STARTED', referral: { ref: 'order_abc', source: 'SHORTLINK', type: 'OPEN_THREAD' } } },
          { sender: { id: 'OLD' }, recipient: { id: 'PAGE' }, timestamp: 11, referral: { ref: 'product_abc', source: 'SHORTLINK', type: 'OPEN_THREAD' } },
          { sender: { id: 'PLAIN' }, recipient: { id: 'PAGE' }, timestamp: 12, postback: { title: 'Get Started', payload: 'GET_STARTED' } },
        ],
      },
    ],
  });
  assert.deepEqual(
    jobs.map((j) => [j.senderExternalId, j.externalId, j.text, j.referral?.ref]),
    [
      ['NEW', 'pb1', '', 'order_abc'],
      ['OLD', 'referral-OLD-11', '', 'product_abc'],
      ['PLAIN', 'postback-PLAIN-12', 'Get Started', undefined],
    ],
  );
});

test('ignores non-page payloads', () => {
  assert.deepEqual(parsePageWebhook({ object: 'instagram', entry: [] }), []);
});

test('splits long text on word boundaries', () => {
  const parts = splitText('word '.repeat(1000), 2000);
  assert.ok(parts.every((p) => p.length <= 2000));
  assert.equal(parts.join(' ').split(' ').length, 1000);
});

test('signed_request: accepts a valid one, rejects tampering', async () => {
  const { parseSignedRequest } = await import('./oauth.ts');
  const payload = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: '42', issued_at: 1 })).toString('base64url');
  const sig = createHmac('sha256', 'secret').update(payload).digest('base64url');
  assert.deepEqual(parseSignedRequest(`${sig}.${payload}`, 'secret'), { user_id: '42', issued_at: 1 });
  assert.equal(parseSignedRequest(`${sig}.${payload}`, 'other'), null);
  const forged = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: '43' })).toString('base64url');
  assert.equal(parseSignedRequest(`${sig}.${forged}`, 'secret'), null);
  assert.equal(parseSignedRequest('garbage', 'secret'), null);
});

test('pages follows paging and sends appsecret_proof', async () => {
  const { FacebookApp } = await import('./oauth.ts');
  const urls: string[] = [];
  const app = new FacebookApp({
    appId: '1',
    appSecret: 'secret',
    version: 'v23.0',
    fetch: (async (url: string) => {
      urls.push(url);
      const page = urls.length === 1
        ? { data: [{ id: 'p1', name: 'One', access_token: 't1', tasks: ['MESSAGING'] }], paging: { cursors: { after: 'c' }, next: 'x' } }
        : { data: [{ id: 'p2', name: 'Two', access_token: 't2' }], paging: { cursors: { after: 'd' } } };
      return new Response(JSON.stringify(page));
    }) as typeof fetch,
  });
  const pages = await app.pages('user-token');
  assert.deepEqual(pages.map((p) => p.id), ['p1', 'p2']);
  assert.match(urls[1]!, /after=c/);
  const proof = createHmac('sha256', 'secret').update('user-token').digest('hex');
  assert.ok(urls.every((u) => u.includes(`appsecret_proof=${proof}`)));
});

test('publishPost uploads photos unpublished, then posts them together with the text', async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const graph = new GraphClient({
    version: 'v23.0',
    fetch: (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ url, body });
      const id = url.endsWith('/photos') ? `photo-${calls.length}` : 'page1_post9';
      return new Response(JSON.stringify({ id }), { status: 200 });
    }) as typeof fetch,
  });
  const id = await graph.publishPost('tok', 'page1', { message: 'New in!', photoUrls: ['https://f.test/a.jpg', 'https://f.test/b.jpg'] });
  assert.equal(id, 'page1_post9');
  assert.deepEqual(
    calls.map((c) => [c.url, c.body]),
    [
      ['https://graph.facebook.com/v23.0/page1/photos', { url: 'https://f.test/a.jpg', published: false }],
      ['https://graph.facebook.com/v23.0/page1/photos', { url: 'https://f.test/b.jpg', published: false }],
      ['https://graph.facebook.com/v23.0/page1/feed', { message: 'New in!', attached_media: [{ media_fbid: 'photo-1' }, { media_fbid: 'photo-2' }] }],
    ],
  );
});

test('a permission error is recognised as one', () => {
  assert.ok(new GraphApiError('(#200) no', 403, 200).permissionMissing);
  assert.ok(!new GraphApiError('expired', 400, 190).permissionMissing);
});
