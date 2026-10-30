import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleProvider } from './openai-compatible.ts';
import { AIProviderError, costUsd } from './provider.ts';

function providerReturning(status: number, body: unknown, seen: { url?: string; body?: any } = {}) {
  return new OpenAICompatibleProvider({
    baseUrl: 'https://llm.example/v1/',
    apiKey: 'k',
    chatModel: 'cheap-model',
    embeddingModel: 'embed-model',
    embeddingDimensions: 3,
    fetch: (async (url: string, init: RequestInit) => {
      seen.url = url;
      seen.body = JSON.parse(init.body as string);
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch,
  });
}

test('chat maps text, tool calls and usage', async () => {
  const seen: { url?: string; body?: any } = {};
  const provider = providerReturning(
    200,
    {
      model: 'cheap-model-2026',
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: 't1', type: 'function', function: { name: 'find_product', arguments: '{"query":"shirt"}' } }],
          },
        },
      ],
      usage: { prompt_tokens: 120, completion_tokens: 8 },
    },
    seen,
  );
  const result = await provider.chat({
    messages: [{ role: 'user', content: 'এই শার্টের দাম কত?' }],
    tools: [{ name: 'find_product', description: 'Find a product', parameters: { type: 'object' } }],
  });
  assert.equal(seen.url, 'https://llm.example/v1/chat/completions');
  assert.equal(seen.body.tools[0].function.name, 'find_product');
  assert.deepEqual(result.toolCalls, [{ id: 't1', name: 'find_product', arguments: { query: 'shirt' } }]);
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 8 });
  assert.equal(result.model, 'cheap-model-2026');
});

test('embed keeps input order and checks dimensions', async () => {
  const ok = providerReturning(200, { data: [{ index: 1, embedding: [4, 5, 6] }, { index: 0, embedding: [1, 2, 3] }] });
  assert.deepEqual(await ok.embed(['a', 'b']), [[1, 2, 3], [4, 5, 6]]);

  const wrong = providerReturning(200, { data: [{ index: 0, embedding: [1, 2] }] });
  await assert.rejects(wrong.embed(['a']), AIProviderError);
});

test('rate limits are retryable, bad requests are not', async () => {
  await assert.rejects(providerReturning(429, {}).chat({ messages: [] }), (e: AIProviderError) => e.retryable);
  await assert.rejects(providerReturning(400, {}).chat({ messages: [] }), (e: AIProviderError) => !e.retryable);
});

test('costUsd uses per-million-token prices', () => {
  const cost = costUsd({ inputTokens: 1_000_000, outputTokens: 500_000 }, { inputPerMTok: 0.1, outputPerMTok: 0.4 });
  assert.ok(Math.abs(cost - 0.3) < 1e-12);
});
