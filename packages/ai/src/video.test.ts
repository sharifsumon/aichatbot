import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FalVideo, videoPrompt } from './video.ts';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

test('talking: the script becomes a voice, then the photo is lip-synced and downloaded', async () => {
  const calls: { url: string; body?: any }[] = [];
  const video = new FalVideo({
    apiKey: 'fk',
    pollMs: 0,
    fetch: (async (url: string, init: RequestInit = {}) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body as string) : undefined });
      // The newest voice model is closed to this key, so the next one is used.
      if (url === 'https://queue.fal.run/fal-ai/minimax/speech-2.6-turbo') return json(403, { detail: 'API key does not have access to model: fal-ai/minimax/speech-2.6-turbo' });
      if (url === 'https://queue.fal.run/fal-ai/minimax/preview/speech-2.5-turbo') return json(200, { request_id: 's1' });
      if (url === 'https://queue.fal.run/fal-ai/kling-video/ai-avatar/v2/standard') return json(200, { request_id: 'v1' });
      if (url.endsWith('/status')) return json(200, { status: 'COMPLETED' });
      if (url.endsWith('/requests/s1')) return json(200, { audio: { url: 'https://fal.media/a.mp3' }, duration_ms: 4000 });
      if (url.endsWith('/requests/v1')) return json(200, { video: { url: 'https://fal.media/v.mp4', content_type: 'video/mp4' }, duration: 4.1 });
      return new Response(new Uint8Array([7, 7]), { status: 200, headers: { 'content-type': 'video/mp4' } });
    }) as typeof fetch,
  });
  const voice = await video.speak({ text: 'Hello', voice: 'Calm_Woman', language: 'auto' });
  assert.equal(voice.audioUrl, 'https://fal.media/a.mp3');
  assert.equal(calls[0]!.body.prompt, 'Hello');
  assert.equal(calls[1]!.body.text, 'Hello');
  assert.equal(calls[1]!.body.voice_setting.voice_id, 'Calm_Woman');
  assert.equal(calls[1]!.body.output_format, 'url');
  const r = await video.talk({ imageUrl: 'https://files.test/p.jpg', audioUrl: voice.audioUrl, prompt: 'p', scriptChars: 5 });
  const submit = calls.find((c) => c.url.endsWith('/ai-avatar/v2/standard'))!;
  assert.deepEqual(submit.body, { image_url: 'https://files.test/p.jpg', audio_url: 'https://fal.media/a.mp3', prompt: 'p' });
  assert.deepEqual([...r.video.bytes], [7, 7]);
  assert.equal(r.durationSec, 4.1);
  assert.ok(Math.abs(r.costUsd - (4.1 * 0.0562 + 0.0005)) < 1e-9);
});

test('walk and talk sends the start image, length and audio flag', async () => {
  let sent: any;
  const video = new FalVideo({
    apiKey: 'fk',
    pollMs: 0,
    walkModel: 'https://fal.ai/models/fal-ai/kling-video/v2.6/pro/image-to-video/api',
    fetch: (async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/image-to-video')) {
        sent = JSON.parse(init.body as string);
        return json(200, { request_id: 'w1' });
      }
      if (url.endsWith('/status')) return json(200, { status: 'COMPLETED' });
      if (url.endsWith('/requests/w1')) return json(200, { video: { url: 'https://fal.media/w.mp4' } });
      return new Response(new Uint8Array([1]), { status: 200 });
    }) as typeof fetch,
  });
  assert.equal(video.walkModel, 'fal-ai/kling-video/v2.6/pro/image-to-video');
  const r = await video.walk({ imageUrl: 'https://files.test/p.jpg', prompt: videoPrompt({ gesture: 'walk', camera: 'follow' }, undefined, 'Shop Now'), seconds: 5 });
  assert.equal(sent.start_image_url, 'https://files.test/p.jpg');
  assert.equal(sent.duration, '5');
  assert.equal(sent.generate_audio, true);
  assert.match(sent.prompt, /runway/);
  assert.match(sent.prompt, /says: "shop now"/);
  assert.equal(r.durationSec, 5);
  assert.ok(Math.abs(r.costUsd - 0.7) < 1e-9);
});

test('an empty fal balance on video says so', async () => {
  const video = new FalVideo({ apiKey: 'k', pollMs: 0, fetch: (async () => json(403, { detail: 'User is locked. Reason: Exhausted balance.' })) as typeof fetch });
  await assert.rejects(video.walk({ imageUrl: 'x', prompt: 'p', seconds: 5 }), (e: { userMessage: string }) => /out of balance/.test(e.userMessage));
});

test('a voice model set by the admin is the only one tried', async () => {
  const urls: string[] = [];
  const video = new FalVideo({
    apiKey: 'k',
    pollMs: 0,
    voiceModel: 'fal-ai/minimax/speech-02-turbo',
    fetch: (async (url: string) => (urls.push(url), json(403, { detail: 'API key does not have access to model' }))) as typeof fetch,
  });
  await assert.rejects(video.speak({ text: 'Hi' }), /does not have access/);
  assert.deepEqual(urls, ['https://queue.fal.run/fal-ai/minimax/speech-02-turbo']);
});

test('a result link that fal refuses is fetched again by owner/app', async () => {
  const fetched: string[] = [];
  const video = new FalVideo({
    apiKey: 'fk',
    pollMs: 0,
    fetch: (async (url: string) => {
      fetched.push(url);
      if (url === 'https://queue.fal.run/fal-ai/kling-video/v2.6/pro/image-to-video')
        return json(200, {
          request_id: 'w2',
          status_url: 'https://queue.fal.run/fal-ai/kling-video/requests/w2/status',
          response_url: 'https://queue.fal.run/fal-ai/kling-video/v2.6/pro/image-to-video/requests/w2',
        });
      if (url.endsWith('/status')) return json(200, { status: 'COMPLETED' });
      if (url.includes('/image-to-video/requests/w2')) return json(403, { detail: 'API key does not have access to model: fal-ai/kling-video/v2.6/pro/image-to-video' });
      if (url === 'https://queue.fal.run/fal-ai/kling-video/requests/w2') return json(200, { video: { url: 'https://fal.media/w.mp4' } });
      return new Response(new Uint8Array([1]), { status: 200 });
    }) as typeof fetch,
  });
  const r = await video.walk({ imageUrl: 'https://files.test/p.jpg', prompt: 'walk', seconds: 5 });
  assert.equal(r.video.bytes.length, 1);
  assert.ok(fetched.includes('https://queue.fal.run/fal-ai/kling-video/requests/w2'));
});

test('a Bangla script is spoken by ElevenLabs v3 with language_code bn', async () => {
  const calls: { url: string; body?: any }[] = [];
  const video = new FalVideo({
    apiKey: 'fk',
    pollMs: 0,
    fetch: (async (url: string, init: RequestInit = {}) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body as string) : undefined });
      if (url === 'https://queue.fal.run/fal-ai/elevenlabs/tts/eleven-v3') return json(200, { request_id: 'b1' });
      if (url.endsWith('/status')) return json(200, { status: 'COMPLETED' });
      if (url.endsWith('/requests/b1')) return json(200, { audio: { url: 'https://fal.media/bn.mp3' } });
      return json(500, {});
    }) as typeof fetch,
  });
  const auto = await video.speak({ text: 'আমাদের নতুন কালেকশন', voice: 'Deep_Voice_Man', language: 'auto' });
  assert.equal(auto.audioUrl, 'https://fal.media/bn.mp3');
  assert.deepEqual(calls[0]!.body, { text: 'আমাদের নতুন কালেকশন', voice: 'George', language_code: 'bn', stability: 0.5 });
  calls.length = 0;
  await video.speak({ text: 'amader notun collection', language: 'Bengali' });
  assert.equal(calls[0]!.url, 'https://queue.fal.run/fal-ai/elevenlabs/tts/eleven-v3');
  assert.equal(calls[0]!.body.voice, 'Sarah');
  assert.ok(!calls.some((c) => c.url.includes('minimax')));
});

test('a chosen language is passed to ElevenLabs as its ISO code', async () => {
  const bodies: any[] = [];
  const video = new FalVideo({
    apiKey: 'fk',
    pollMs: 0,
    fetch: (async (url: string, init: RequestInit = {}) => {
      if (init.body) bodies.push({ url, ...JSON.parse(init.body as string) });
      if (init.method === 'POST') return json(200, { request_id: 'x1' });
      if (url.endsWith('/status')) return json(200, { status: 'COMPLETED' });
      return json(200, { audio: { url: 'https://fal.media/x.mp3' } });
    }) as typeof fetch,
  });
  await video.speak({ text: 'Hola', language: 'Spanish' });
  assert.equal(bodies[0].url, 'https://queue.fal.run/fal-ai/elevenlabs/tts/eleven-v3');
  assert.equal(bodies[0].language_code, 'es');
});
