import { desc, eq } from 'drizzle-orm';
import { messages, type Db } from '@agently/db';
import type { AIProvider, ChatMessage, Usage } from '@agently/ai';
import { detectLanguage, type ReplyLanguage } from './language.ts';
import { HANDOFF_TOOL, buildSystemPrompt, type PromptContext } from './prompt.ts';
import { searchKnowledge, searchProducts } from './retrieval.ts';

const HISTORY = 12;

export interface ReplyDraft {
  language: ReplyLanguage;
  text: string;
  /** Set when the model asked to pass the conversation to staff. */
  handoffReason?: string;
  sources: { type: 'chunk' | 'product'; id: string }[];
  usage: Usage;
  model: string;
}

export type ShopContext = Omit<PromptContext, 'language' | 'kind' | 'knowledge' | 'products'>;

/** Retrieval, prompt and one model call. Sends nothing. */
export async function generateReply(
  deps: { db: Db; ai: AIProvider; warn: (err: unknown, msg: string) => void },
  input: { workspaceId: string; conversationId: string; customerText: string; kind: 'message' | 'comment'; shop: ShopContext },
): Promise<ReplyDraft> {
  const { db, ai } = deps;
  const language = detectLanguage(input.customerText);

  const [knowledge, products, history] = await Promise.all([
    // A broken embedding call should not stop the bot answering from the catalog.
    searchKnowledge(db, ai, input.workspaceId, input.customerText).catch((err: unknown) => {
      deps.warn(err, 'Knowledge search failed');
      return [];
    }),
    searchProducts(db, input.workspaceId, input.customerText),
    db
      .select({ sender: messages.sender, text: messages.text })
      .from(messages)
      .where(eq(messages.conversationId, input.conversationId))
      .orderBy(desc(messages.createdAt))
      .limit(HISTORY),
  ]);

  const chat: ChatMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt({ ...input.shop, language, kind: input.kind, knowledge, products }),
    },
    ...history
      .reverse()
      .filter((m) => m.text)
      .map((m): ChatMessage => (m.sender === 'customer' ? { role: 'user', content: m.text } : { role: 'assistant', content: m.text })),
  ];

  const result = await ai.chat({ messages: chat, tools: [HANDOFF_TOOL], maxTokens: 500 });
  const handoff = result.toolCalls.find((c) => c.name === HANDOFF_TOOL.name);

  return {
    language,
    text: result.text.trim(),
    handoffReason: handoff ? String(handoff.arguments.reason ?? 'Model asked for a person') : undefined,
    sources: [
      ...knowledge.map((k) => ({ type: 'chunk' as const, id: k.id })),
      ...products.map((p) => ({ type: 'product' as const, id: p.id })),
    ],
    usage: result.usage,
    model: result.model,
  };
}
