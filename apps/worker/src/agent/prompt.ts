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
  /** Whether order tools are available (private chat only). */
  canOrder: boolean;
  /** The customer's confirmed order that still needs details. */
  openOrder?: OpenOrder;
}

export interface OpenOrder {
  number: number;
  step: 'awaiting_address' | 'awaiting_payment_method' | 'awaiting_transaction_id' | 'complete';
  items: string[];
  subtotal: string;
  deliveryCharge?: string;
  total: string;
  paymentMethod?: string;
}

const NEXT_STEP: Record<OpenOrder['step'], string> = {
  awaiting_address: 'Ask for name, mobile number, full address, and inside or outside Dhaka, then call set_delivery_details.',
  awaiting_payment_method: 'Tell the total including delivery and ask how they will pay, then call set_payment_method.',
  awaiting_transaction_id: 'Ask for the transaction ID of their payment, then call submit_transaction_id.',
  complete: 'Nothing; the order is complete.',
};

const ORDERING_RULES = `
How to take an order:
1. Find the exact product, colour and size, and check it is in stock.
2. Repeat the items, quantities, prices and subtotal, say delivery is extra, and ask the customer to confirm.
3. Only after they clearly confirm, call create_order. The order is then confirmed.
4. Ask for name, mobile number, full address, and whether it is inside or outside Dhaka; call set_delivery_details.
5. Tell the total including delivery and ask how they will pay; call set_payment_method.
6. For bKash or Nagad, tell them the number and amount, ask for the transaction ID, and call submit_transaction_id. Say staff will check the payment; never say it is verified.
If a tool returns an error, explain it simply and ask the customer for what is missing.`;

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

  const open = c.openOrder
    ? `\nOrder in progress: #${c.openOrder.number}
${c.openOrder.items.map((i) => `- ${i}`).join('\n')}
Subtotal ${c.currency} ${c.openOrder.subtotal}${c.openOrder.deliveryCharge ? `, delivery ${c.currency} ${c.openOrder.deliveryCharge}, total ${c.currency} ${c.openOrder.total}` : ''}${c.openOrder.paymentMethod ? `, paying by ${c.openOrder.paymentMethod}` : ''}
Next: ${NEXT_STEP[c.openOrder.step]}\n`
    : '';

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
${c.canOrder ? ORDERING_RULES : '- Do not take orders here. Invite the customer to message the page to order.'}
${open}${c.systemInstruction ? `\nShop owner's instructions:\n${c.systemInstruction}\n` : ''}
Products:
${productLines}

Shop knowledge:
${knowledgeLines}`;
}
