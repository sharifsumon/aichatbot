/** Shapes the dashboard API returns. Dates arrive as ISO strings. */

export type Role = 'owner' | 'admin' | 'agent';
export type ShopStatus = 'trial' | 'active' | 'past_due' | 'suspended';

export interface Me {
  user: { id: string; name: string; email: string | null };
  workspaces: { id: string; name: string; role: Role; status: ShopStatus; suspendedReason: string | null; onboardingCompletedAt: string | null }[];
}

export type Shop = Me['workspaces'][number];

export interface CreditSummary {
  granted: number;
  used: number;
  remaining: number;
  percentUsed: number;
  warning: 'low' | 'out' | null;
  periodEnd: string;
}

export interface Channel {
  id: string;
  type: 'facebook_page' | 'instagram' | 'whatsapp' | 'widget' | 'telegram';
  name: string;
  status: 'connected' | 'token_expired' | 'disconnected' | 'error';
  lastError: string | null;
  createdAt: string;
}

export interface Activity {
  id: string;
  type: string;
  text: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface Home {
  shop: { name: string; status: ShopStatus; trialEndsAt: string | null; suspendedReason: string | null; onboardingCompletedAt: string | null };
  agent: { name: string; status: AgentStatus } | null;
  channels: Channel[];
  stats: { needsYou: number; aiHandling: number; ordersToday: number; awaitingPayment: number; toShip: number; ordersThisMonth: number; revenueThisMonth: string };
  setup: { pageConnected: boolean; products: number; knowledgeSources: number; paymentNumbers: boolean; agentLive: boolean };
  credits: CreditSummary;
  activity: Activity[];
}

export interface ConversationRow {
  id: string;
  mode: 'ai' | 'human';
  status: 'open' | 'closed';
  flagged: boolean;
  handoffReason: string | null;
  assignedUserId: string | null;
  lastMessageAt: string;
  customer: { id: string; name: string | null; phone: string | null };
  channel: { id: string; type: Channel['type']; name: string };
  preview: string | null;
}

export interface Message {
  id: string;
  direction: 'inbound' | 'outbound';
  kind: 'message' | 'comment' | 'comment_reply' | 'private_reply';
  sender: 'customer' | 'ai' | 'staff' | 'support' | 'system';
  text: string;
  attachments: { type: string; url?: string }[];
  delivery: 'received' | 'pending' | 'sent' | 'failed';
  meta: { postId?: string; error?: string };
  createdAt: string;
}

export interface OrderItem {
  id: string;
  title: string;
  code: string;
  color: string;
  size: string;
  quantity: number;
  unitPrice: string;
}

export type OrderStatus = 'confirmed' | 'shipped' | 'delivered' | 'returned' | 'cancelled';
export type PaymentStatus = 'unpaid' | 'cod_due' | 'pending_verification' | 'paid' | 'rejected' | 'refunded';

export interface Order {
  id: string;
  number: number;
  source: 'ai' | 'staff' | string;
  status: OrderStatus;
  checkoutStep: 'awaiting_address' | 'awaiting_payment_method' | 'awaiting_transaction_id' | 'complete';
  customerId: string;
  conversationId: string | null;
  customerName: string | null;
  phone: string | null;
  address: string | null;
  deliveryZone: 'inside_dhaka' | 'outside_dhaka' | null;
  subtotal: string;
  deliveryCharge: string;
  total: string;
  paymentMethod: 'cod' | 'bkash' | 'nagad' | null;
  paymentStatus: PaymentStatus;
  paymentTransactionId: string | null;
  paymentSenderNumber: string | null;
  courier: string | null;
  consignmentId: string | null;
  trackingUrl: string | null;
  notes: string | null;
  createdAt: string;
  items: OrderItem[];
}

export interface ConversationDetail {
  conversation: {
    id: string;
    mode: 'ai' | 'human';
    handoffReason: string | null;
    canReply: boolean;
    customer: { id: string; name: string | null; phone: string | null; address: string | null };
    channel: { id: string; type: Channel['type']; name: string; status: Channel['status'] };
  };
  messages: Message[];
  olderCursor: string | null;
  orders: Order[];
  history: { orders: number; total: string; firstOrderAt: string | null };
}

export interface Variant {
  id?: string;
  color: string;
  size: string;
  stock: number;
  price: string | null;
}

export interface ProductImage {
  url: string;
  color: string;
}

export interface Product {
  id: string;
  title: string;
  code: string;
  description: string;
  price: string;
  imageUrl: string | null;
  /** In order; the first is the main photo. `color` is '' for the whole product. */
  images: ProductImage[];
  status: 'active' | 'draft' | 'archived';
  variants: Variant[];
  colors: string[];
  sizes: string[];
  totalStock: number;
}

/** A product published as a post on the shop's Facebook page. */
export interface FacebookPost {
  id: string;
  postId: string;
  url: string;
  pageName: string;
  createdAt: string;
}

export interface Comment {
  id: string;
  text: string;
  createdAt: string;
  postId: string | null;
  conversationId: string;
  mode: 'ai' | 'human';
  customer: { id: string; name: string | null };
  channel: { id: string; name: string; type: Channel['type'] };
  replies: { id: string; kind: Message['kind']; sender: Message['sender']; text: string; delivery: Message['delivery']; createdAt: string }[];
}

export type AgentStatus = 'setup' | 'live' | 'paused';

export interface Agent {
  id: string;
  name: string;
  tone: 'friendly' | 'professional' | 'casual' | 'formal';
  systemInstruction: string;
  languages: ('bn' | 'en')[];
  handoffEnabled: boolean;
  handoffRules: { minConfidence: number; onComplaint: boolean; onHumanRequest: boolean; keywords: string[] };
  commentReplyMode: 'off' | 'public' | 'private' | 'public_and_private';
  status: AgentStatus;
}

export interface Settings {
  name: string;
  locale: 'bn' | 'en';
  businessType: 'ecommerce' | 'services' | 'other';
  currency: string;
  deliveryChargeInsideDhaka: string;
  deliveryChargeOutsideDhaka: string;
  bkashNumber: string | null;
  nagadNumber: string | null;
  codEnabled: boolean;
  status: ShopStatus;
  trialEndsAt: string | null;
}

export interface KnowledgeSource {
  id: string;
  type: 'file' | 'text' | 'qa' | 'website' | 'sheet';
  name: string;
  url: string | null;
  fileSizeBytes: number | null;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  error: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
  chunks?: number;
}

export interface Team {
  members: { userId: string; name: string | null; email: string | null; role: Role; joinedAt: string }[];
  invites: { id: string; role: Role; email: string | null; expiresAt: string; createdAt: string }[];
  seats: { used: number; limit: number };
}

export interface Limits {
  pages: number;
  agents: number;
  aiCreditsPerMonth: number;
  knowledgeBaseMb: number;
  staffSeats: number;
}

export interface Billing {
  status: ShopStatus;
  trialEndsAt: string | null;
  trialEnded: boolean;
  currency: 'BDT' | 'USD';
  plan: { key: string; name: string; priceBdt: string; priceUsd: string } | null;
  credits: CreditSummary;
  usage: {
    pages: { used: number; limit: number };
    agents: { used: number; limit: number };
    staffSeats: { used: number; limit: number };
    knowledgeBase: { usedBytes: number; limitBytes: number };
  };
  plans: { key: string; name: string; priceBdt: string; priceUsd: string; limits: Limits; current: boolean }[];
  topUp: { credits: number; priceBdt: string; priceUsd: string };
  paymentsAvailable: boolean;
}

export const MANAGERS: Role[] = ['owner', 'admin'];
