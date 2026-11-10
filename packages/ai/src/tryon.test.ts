import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FashnTryOn, GeminiTryOn, TryOnError, tryOnFromEnv } from './tryon.ts';

const img = (b: number[]) => ({ bytes: new Uint8Array(b), contentType: 'image/jpeg' });
const req = { model: img([1, 2]), garment: img([3, 4]), category: 'one-pieces' as const };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

test('FASHN starts a run, polls and returns the base64 image', async () => {
  const calls: { url: string; body?: any }[] = [];
  let polls = 0;
  const provider = new FashnTryOn({
    apiKey: 'k',
    pollMs: 0,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body as string) : undefined });
      if (url.endsWith('/run')) return json(200, { id: 'p1', error: null });
      polls++;
      if (polls === 1) return json(200, { id: 'p1', status: 'processing' });
      return json(200, { id: 'p1', status: 'completed', output: [`data:image/jpeg;base64,${Buffer.from([9, 9]).toString('base64')}`] });
    }) as typeof fetch,
  });
  const r = await provider.tryOn(req);
  assert.deepEqual([...r.image.bytes], [9, 9]);
  assert.equal(r.image.contentType, 'image/jpeg');
  assert.equal(r.costUsd, 0.075);
  assert.equal(calls[0]!.body.model_name, 'tryon-v1.6');
  assert.equal(calls[0]!.body.inputs.category, 'one-pieces');
  assert.match(calls[0]!.body.inputs.model_image, /^data:image\/jpeg;base64,/);
  assert.equal(calls[1]!.url, 'https://api.fashn.ai/v1/status/p1');
});

test('FASHN failure carries a message the shop can read', async () => {
  const provider = new FashnTryOn({
    apiKey: 'k',
    pollMs: 0,
    fetch: (async (url: string) =>
      url.endsWith('/run') ? json(200, { id: 'p1' }) : json(200, { status: 'failed', error: { name: 'PoseError', message: 'no person' } })) as typeof fetch,
  });
  await assert.rejects(provider.tryOn(req), (e: TryOnError) => e instanceof TryOnError && /clear person/.test(e.userMessage));
});

test('Gemini sends both photos and reads the image part', async () => {
  let sent: any;
  let url = '';
  const provider = new GeminiTryOn({
    apiKey: 'g',
    fetch: (async (u: string, init: RequestInit) => {
      url = u;
      sent = JSON.parse(init.body as string);
      return json(200, { candidates: [{ content: { parts: [{ text: 'ok' }, { inlineData: { mimeType: 'image/png', data: Buffer.from([7]).toString('base64') } }] } }] });
    }) as typeof fetch,
  });
  const r = await provider.tryOn(req);
  assert.match(url, /models\/gemini-2\.5-flash-image:generateContent$/);
  assert.equal(sent.contents[0].parts.length, 3);
  assert.equal(sent.contents[0].parts[1].inline_data.data, Buffer.from([1, 2]).toString('base64'));
  assert.deepEqual([...r.image.bytes], [7]);
  assert.equal(r.image.contentType, 'image/png');
});

test('settings pick the service; no key means off', () => {
  assert.equal(tryOnFromEnv({}), undefined);
  assert.equal(tryOnFromEnv({ TRYON_API_KEY: 'k' })?.name, 'fashn');
  assert.equal(tryOnFromEnv({ TRYON_API_KEY: 'k', TRYON_PROVIDER: 'gemini', TRYON_MODEL: 'gemini-x' })?.model, 'gemini-x');
  assert.throws(() => tryOnFromEnv({ TRYON_API_KEY: 'k', TRYON_PROVIDER: 'other' }));
});
