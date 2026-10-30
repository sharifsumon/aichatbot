import type { ToolDefinition } from '@agently/ai';
import type { ReplyLanguage } from './language.ts';
import type { KnowledgeHit, ProductFact } from './retrieval.ts';

const LANGUAGE_RULE: Record<ReplyLanguage, string> = {
  bn: 'The customer wrote in Bangla. Reply in Bangla script.',
  banglish: 'The customer wrote Bangla in English letters (Banglish). Reply the same way, in Banglish.',
  en: 'The customer wrote in English. Reply in English.',
};

export interface PromptContext {
  shopName: string;
  agentName: string;
  tone: string;
  systemInstruction: string;
  language: ReplyLanguage;
  kind: 'message' | 'comment';
  currency: string;
  deliveryInsideDhaka: string;
  deliveryOutsideDhaka: string;
  paymentMethods: string[];
  knowledge: KnowledgeHit[];
  products: ProductFact[];
}

export const HANDOFF_TOOL: ToolDefinition = {
  name: 'handoff_to_human',
  description:
    'Pass the conversation to shop staff. Use when the customer asks for a person, complains, ' +
    'or asks something the shop facts below do not answer.',
  parameters: {
    type: 'object',
    properties: { reason: { type: 'string', description: 'One short sentence for staff.' } },
    required: ['reason'],
  },
};

export function buildSystemPrompt(c: PromptContext): string {
  const productLines = c.products.length
    ? c.products
        .map((p) => {
          const stock = p.variants.length
            ? p.variants
                .map((v) => `${[v.color, v.size].filter(Boolean).join('/') || 'default'}: ${v.stock > 0 ? `${v.stock} in stock` : 'out of stock'}${v.price ? ` (${c.currency} ${v.price})` : ''}`)
                .join('; ')
            : 'no stock recorded';
          return `- ${p.title} [code ${p.code}] ${c.currency} ${p.price}. ${p.description}\n  Stock: ${stock}`;
        })
        .join('\n')
    : '(no matching products)';

  const knowledgeLines = c.knowledge.length ? c.knowledge.map((k) => `- ${k.content}`).join('\n') : '(nothing relevant)';

  return `You are ${c.agentName}, the sales and support assistant for ${c.shopName}, an online shop in Bangladesh.
Tone: ${c.tone}. Keep replies short, like a helpful shop assistant in Messenger.
${LANGUAGE_RULE[c.language]}
${c.kind === 'comment' ? 'This is a comment on a public Facebook post. Keep it to one or two sentences and never share the customer\'s personal details.' : ''}

Rules you must follow:
- Use only the shop facts below. Never state a price, stock level, delivery charge or delivery time that is not written there.
- If a product, size or colour is not listed, say you will check, and call handoff_to_human.
- Never invent discounts, offers or policies.
- Delivery charge: inside Dhaka ${c.currency} ${c.deliveryInsideDhaka}, outside Dhaka ${c.currency} ${c.deliveryOutsideDhaka}.
- Payment methods: ${c.paymentMethods.join(', ')}.
${c.systemInstruction ? `\nShop owner's instructions:\n${c.systemInstruction}\n` : ''}
Products:
${productLines}

Shop knowledge:
${knowledgeLines}`;
}
