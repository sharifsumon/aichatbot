/**
 * The one interface the rest of Agently uses to talk to a language model.
 * Swapping a hosted API for a self-hosted model means adding a provider here,
 * not changing the worker.
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed JSON arguments. */
  arguments: Record<string, unknown>;
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string };

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  model: string;
}

export interface AIProvider {
  readonly chatModel: string;
  chat(request: ChatRequest): Promise<ChatResult>;
  /** One vector per input, all the same length (AI_EMBEDDING_DIMENSIONS). */
  embed(texts: string[]): Promise<number[][]>;
}

export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

export function costUsd(usage: Usage, pricing: Pricing): number {
  return (usage.inputTokens * pricing.inputPerMTok + usage.outputTokens * pricing.outputPerMTok) / 1_000_000;
}

export class AIProviderError extends Error {
  readonly status?: number;
  /** Rate limits and server errors are worth retrying; bad requests are not. */
  readonly retryable: boolean;

  constructor(message: string, status?: number, retryable = false) {
    super(message);
    this.name = 'AIProviderError';
    this.status = status;
    this.retryable = retryable;
  }
}
