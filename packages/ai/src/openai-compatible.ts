import { AIProviderError, type AIProvider, type ChatMessage, type ChatRequest, type ChatResult, type ToolCall } from './provider.ts';

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string;
  chatModel: string;
  embeddingModel: string;
  embeddingDimensions: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/**
 * Talks to any server that speaks the OpenAI chat completions and embeddings
 * format. Most cheap hosted APIs do, and so do vLLM and Ollama, so the same
 * class serves the hosted model now and a self-hosted one later.
 */
export class OpenAICompatibleProvider implements AIProvider {
  readonly chatModel: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly options: OpenAICompatibleOptions;

  constructor(options: OpenAICompatibleOptions) {
    this.options = options;
    this.chatModel = options.chatModel;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? fetch;
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const body = {
      model: this.chatModel,
      messages: request.messages.map(toWireMessage),
      temperature: request.temperature ?? 0.3,
      ...(request.maxTokens && { max_tokens: request.maxTokens }),
      ...(request.tools?.length && {
        tools: request.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
      }),
    };
    const json = await this.post<{
      model?: string;
      choices: { message: { content: string | null; tool_calls?: WireToolCall[] } }[];
      usage?: { prompt_tokens: number; completion_tokens: number };
    }>('/chat/completions', body);

    const message = json.choices[0]?.message;
    if (!message) throw new AIProviderError('Model returned no choices');
    return {
      text: message.content ?? '',
      toolCalls: (message.tool_calls ?? []).map(fromWireToolCall),
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
      },
      model: json.model ?? this.chatModel,
    };
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const json = await this.post<{ data: { index: number; embedding: number[] }[] }>('/embeddings', {
      model: this.options.embeddingModel,
      input: texts,
      dimensions: this.options.embeddingDimensions,
    });
    const vectors = [...json.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    for (const v of vectors) {
      if (v.length !== this.options.embeddingDimensions) {
        throw new AIProviderError(
          `Embedding has ${v.length} dimensions, expected ${this.options.embeddingDimensions}`,
        );
      }
    }
    return vectors;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.apiKey && { authorization: `Bearer ${this.options.apiKey}` }),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      });
    } catch (err) {
      throw new AIProviderError(`Request to model failed: ${(err as Error).message}`, undefined, true);
    }
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 500);
      throw new AIProviderError(
        `Model API returned ${res.status}: ${detail}`,
        res.status,
        res.status === 429 || res.status >= 500,
      );
    }
    return (await res.json()) as T;
  }
}

function toWireMessage(m: ChatMessage) {
  switch (m.role) {
    case 'assistant':
      return {
        role: 'assistant',
        content: m.content,
        ...(m.toolCalls?.length && {
          tool_calls: m.toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.arguments) },
          })),
        }),
      };
    case 'tool':
      return { role: 'tool', content: m.content, tool_call_id: m.toolCallId };
    default:
      return { role: m.role, content: m.content };
  }
}

function fromWireToolCall(c: WireToolCall): ToolCall {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(c.function.arguments || '{}') as Record<string, unknown>;
  } catch {
    // Leave args empty; the tool handler validates and reports the problem back to the model.
  }
  return { id: c.id, name: c.function.name, arguments: args };
}
