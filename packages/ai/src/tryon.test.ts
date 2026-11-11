import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FalTryOn, falModelId, FashnTryOn, GeminiTryOn, TryOnError, tryOnFromEnv, tryOnPrompt } from './tryon.ts';

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

test('fal.ai submits to the queue with public links, polls, and downloads the image', async () => {
  const calls: { url: string; method?: string; body?: any; auth?: string }[] = [];
  let polls = 0;
  const provider = new FalTryOn({
    apiKey: 'fk',
    pollMs: 0,
    fetch: (async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body as string) : undefined, auth: (init.headers as Record<string, string> | undefined)?.authorization });
      if (url === 'https://queue.fal.run/fal-ai/nano-banana/edit') {
        return json(200, { request_id: 'r1', status_url: 'https://queue.fal.run/fal-ai/nano-banana/requests/r1/status', response_url: 'https://queue.fal.run/fal-ai/nano-banana/requests/r1' });
      }
      if (url.endsWith('/status')) return json(200, { status: ++polls === 1 ? 'IN_PROGRESS' : 'COMPLETED' });
      if (url.endsWith('/requests/r1')) return json(200, { images: [{ url: 'https://fal.media/out.jpg', content_type: 'image/jpeg' }], description: '' });
      return new Response(new Uint8Array([5, 6]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }) as typeof fetch,
  });
  const r = await provider.tryOn({ ...req, model: { ...req.model, url: 'https://files.example/m.jpg' } });
  assert.equal(calls[0]!.auth, 'Key fk');
  assert.equal(calls[0]!.body.image_urls[0], 'https://files.example/m.jpg');
  assert.match(calls[0]!.body.image_urls[1], /^data:image\/jpeg;base64,/);
  assert.match(calls[0]!.body.prompt, /full outfit/);
  assert.equal(calls.at(-1)!.url, 'https://fal.media/out.jpg');
  assert.deepEqual([...r.image.bytes], [5, 6]);
  assert.equal(r.costUsd, 0.0398);

  // Without a model photo, only the garment is sent and the prompt asks for a new model.
  calls.length = 0;
  polls = 0;
  await provider.tryOn({ ...req, model: undefined, note: 'a young woman in a garden' });
  assert.equal(calls[0]!.body.image_urls.length, 1);
  assert.match(calls[0]!.body.prompt, /fashion model wearing exactly/);
  assert.match(calls[0]!.body.prompt, /a young woman in a garden/);
});

test('fal.ai refused key and failed runs carry readable messages', async () => {
  const refused = new FalTryOn({ apiKey: 'bad', pollMs: 0, fetch: (async () => json(401, { detail: 'Invalid key' })) as typeof fetch });
  await assert.rejects(refused.tryOn(req), (e: TryOnError) => /API key was refused/.test(e.userMessage));
  const failed = new FalTryOn({
    apiKey: 'k',
    pollMs: 0,
    model: 'fal-ai/nano-banana-2/edit',
    fetch: (async (url: string) =>
      url.endsWith('/edit') ? json(200, { request_id: 'r2' }) : url.endsWith('/status') ? json(200, { status: 'COMPLETED' }) : json(422, { detail: [{ msg: 'content policy violation' }] })) as typeof fetch,
  });
  await assert.rejects(failed.tryOn(req), (e: TryOnError) => /content rules/.test(e.userMessage));
  assert.equal(tryOnFromEnv({ TRYON_API_KEY: 'k', TRYON_PROVIDER: 'fal' })?.model, 'fal-ai/nano-banana/edit');
});

test('fal model names typed in many ways become an endpoint id', () => {
  assert.equal(falModelId(''), 'fal-ai/nano-banana/edit');
  assert.equal(falModelId('  '), 'fal-ai/nano-banana/edit');
  assert.equal(falModelId('fal-ai/nano-banana/edit'), 'fal-ai/nano-banana/edit');
  assert.equal(falModelId('https://fal.ai/models/fal-ai/nano-banana/api#api-call-setup'), 'fal-ai/nano-banana/edit');
  assert.equal(falModelId('https://fal.ai/models/fal-ai/nano-banana-pro/edit/api'), 'fal-ai/nano-banana-pro/edit');
  assert.equal(falModelId('nano-banana-2'), 'fal-ai/nano-banana-2/edit');
  assert.equal(falModelId('/fal-ai/nano-banana/'), 'fal-ai/nano-banana/edit');
  assert.equal(falModelId('https://queue.fal.run/fal-ai/nano-banana-2/edit'), 'fal-ai/nano-banana-2/edit');
});

test('fal.ai 404 says the model name is wrong', async () => {
  const p = new FalTryOn({ apiKey: 'k', pollMs: 0, model: 'fal-ai/nope/edit', fetch: (async () => json(404, {})) as typeof fetch });
  await assert.rejects(p.tryOn(req), (e: TryOnError) => /no model called fal-ai\/nope\/edit/.test(e.userMessage));
});

test('fal.ai 400 shows the reason fal gives', async () => {
  const p = new FalTryOn({ apiKey: 'k', pollMs: 0, fetch: (async () => json(400, { detail: 'Cannot target application revisions directly.' })) as typeof fetch });
  await assert.rejects(p.tryOn(req), (e: TryOnError) => e.userMessage === 'fal.ai did not accept the request: Cannot target application revisions directly.');
});

test('fal.ai empty balance says to top up, not that the key is wrong', async () => {
  const p = new FalTryOn({
    apiKey: 'k',
    pollMs: 0,
    fetch: (async () => json(403, { detail: 'User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing.' })) as typeof fetch,
  });
  await assert.rejects(p.tryOn(req), (e: TryOnError) => /out of balance/.test(e.userMessage));
});

test('the prompt carries the chosen pose, expression, background and the shop note', () => {
  const plain = tryOnPrompt(req);
  assert.match(plain, /Keep the pose\./);
  assert.match(plain, /Keep the background\./);
  const styled = tryOnPrompt({ ...req, style: { pose: 'sitting', expression: 'smile', background: 'white' }, note: 'holding a red clutch' });
  assert.match(styled, /Pose: sitting/);
  assert.match(styled, /Expression: a natural, warm smile/);
  assert.match(styled, /Background: a clean plain white studio background/);
  assert.match(styled, /holding a red clutch/);
  assert.doesNotMatch(styled, /Keep the (pose|background)/);
});
