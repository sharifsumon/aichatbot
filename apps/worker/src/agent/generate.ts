import { desc, eq } from 'drizzle-orm';
import { findOpenCheckout } from '@agently/commerce';
import { messages, orderItems, type Db } from '@agently/db';
import type { AIProvider, ChatMessage, Usage } from '@agently/ai';
import { detectLanguage, type ReplyLanguage } from './language.ts';
import { HANDOFF_TOOL, buildSystemPrompt, type OpenOrder, type PromptContext } from './prompt.ts';
import { searchKnowledge, searchProducts } from './retrieval.ts';
import { ORDER_TOOLS, runTool } from './tools.ts';

const HISTORY = 12;
/** Model calls per reply; each tool round is one call. */
const MAX_ROUNDS = 5;

export interface ReplyDraft {
  language: ReplyLanguage;
  text: string;
  /** Set when the model asked to pass the conversation to staff. */
  handoffReason?: string;
  sources: { type: 'chunk' | 'product'; id: string }[];
  usage: Usage;
  model: string;
}

export type ShopContext = Omit<PromptContext, 'language' | 'kind' | 'knowledge' | 'products' | 'openOrder' | 'canOrder'>;

/** Retrieval, prompt, and model calls with order tools. Sends nothing to the customer. */
export async function generateReply(
  deps: { db: Db; ai: AIProvider; warn: (err: unknown, msg: string) => void },
  input: {
    workspaceId: string;
    customerId: string;
    conversationId: string;
    customerText: string;
    kind: 'message' | 'comment';
    /** Orders are taken in Messenger chat only, never from a comment. */
    canOrder: boolean;
    shop: ShopContext;
  },
): Promise<ReplyDraft> {
  const { db, ai } = deps;
  const language = detectLanguage(input.customerText);
  const scope = { workspaceId: input.workspaceId, customerId: input.customerId };
  const { canOrder } = input;

  const [knowledge, products, history, openOrder] = await Promise.all([
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
    canOrder ? loadOpenOrder(db, scope) : undefined,
  ]);

  const chat: ChatMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt({ ...input.shop, language, kind: input.kind, knowledge, products, openOrder, canOrder }),
    },
    ...history
      .reverse()
      .filter((m) => m.text)
      .map((m): ChatMessage => (m.sender === 'customer' ? { role: 'user', content: m.text } : { role: 'assistant', content: m.text })),
  ];

  const tools = canOrder ? [...ORDER_TOOLS, HANDOFF_TOOL] : [HANDOFF_TOOL];
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const productIds = new Set(products.map((p) => p.id));
  let model = ai.chatModel;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    // The last round gets no tools, so the model has to answer in words.
    const result = await ai.chat({ messages: chat, tools: round < MAX_ROUNDS ? tools : undefined, maxTokens: 500 });
    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    model = result.model;

    const handoff = result.toolCalls.find((c) => c.name === HANDOFF_TOOL.name);
    const calls = result.toolCalls.filter((c) => c.name !== HANDOFF_TOOL.name);
    if (handoff || calls.length === 0) {
      return {
        language,
        text: result.text.trim(),
        handoffReason: handoff ? String(handoff.arguments.reason ?? 'Model asked for a person') : undefined,
        sources: [
          ...knowledge.map((k) => ({ type: 'chunk' as const, id: k.id })),
          ...[...productIds].map((id) => ({ type: 'product' as const, id })),
        ],
        usage,
        model,
      };
    }

    chat.push({ role: 'assistant', content: result.text, toolCalls: calls });
    for (const call of calls) {
      const out = await runTool({ db, scope, conversationId: input.conversationId }, call);
      out.productIds?.forEach((id) => productIds.add(id));
      chat.push({ role: 'tool', toolCallId: call.id, content: out.content });
    }
  }
  throw new Error('unreachable: the last round has no tools');
}

async function loadOpenOrder(db: Db, scope: { workspaceId: string; customerId: string }): Promise<OpenOrder | undefined> {
  const order = await findOpenCheckout(db, scope);
  if (!order) return undefined;
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
  return {
    number: order.number,
    step: order.checkoutStep,
    items: items.map((i) => `${i.quantity} × ${[i.title, i.color, i.size].filter(Boolean).join(' ')} @ ${i.unitPrice}`),
    subtotal: order.subtotal,
    deliveryCharge: order.deliveryZone ? order.deliveryCharge : undefined,
    total: order.total,
    paymentMethod: order.paymentMethod ?? undefined,
  };
}
