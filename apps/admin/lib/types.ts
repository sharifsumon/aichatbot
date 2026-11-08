/** Shapes of the admin API's responses (apps/api/src/admin). */

export type PlatformRole = 'super_admin' | 'support' | 'finance';
export type TenantStatus = 'trial' | 'active' | 'past_due' | 'suspended';

export interface Admin {
  id: string;
  name: string;
  email: string;
  role: PlatformRole;
}

/** Mirrors PERMISSIONS in apps/api/src/admin/guard.ts. The API enforces it; the panel only hides what would be refused. */
export const PERMISSIONS = {
  'tenants.read': ['super_admin', 'support', 'finance'],
  'tenants.manage': ['super_admin', 'support'],
  conversations: ['super_admin', 'support'],
  'usage.read': ['super_admin', 'support', 'finance'],
  'billing.manage': ['super_admin', 'finance'],
  'audit.read': ['super_admin'],
  'team.manage': ['super_admin'],
  'settings.manage': ['super_admin'],
} satisfies Record<string, PlatformRole[]>;
export type Permission = keyof typeof PERMISSIONS;
export const can = (role: PlatformRole | undefined, perm: Permission) => !!role && (PERMISSIONS[perm] as PlatformRole[]).includes(role);

export const ROLE_LABEL: Record<PlatformRole, string> = { super_admin: 'Super admin', support: 'Support', finance: 'Finance' };

export interface Limits {
  pages: number;
  agents: number;
  aiCreditsPerMonth: number;
  knowledgeBaseMb: number;
  staffSeats: number;
}

export interface Plan {
  id: string;
  key: string;
  name: string;
  priceBdt: string;
  priceUsd: string;
  trialDays: number | null;
  limits: Limits;
  active: boolean;
  tenants: number;
}

export interface TenantRow {
  id: string;
  name: string;
  status: TenantStatus;
  trialEndsAt: string | null;
  createdAt: string;
  plan: { key: string; name: string } | null;
  owner: { name: string | null; email: string | null } | null;
  pagesConnected: number;
  aiRepliesThisMonth: number;
  aiCostThisMonth: string;
  creditsGranted: number;
  ordersLast30Days: number;
  lastActiveAt: string | null;
}

export interface CreditSummary {
  granted: number;
  used: number;
  remaining: number;
  percentUsed: number;
  warning: 'low' | 'out' | null;
  periodEnd: string;
}

export interface UsageDay {
  day: string;
  aiReplies: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: string;
  failedCalls: number;
}

export interface TenantDetail {
  tenant: {
    id: string;
    name: string;
    status: TenantStatus;
    suspendedReason: string | null;
    trialEndsAt: string | null;
    billingCountry: string;
    locale: string;
    currency: string;
    createdAt: string;
    plan: { key: string; name: string; limits: Limits } | null;
  };
  members: { userId: string; name: string | null; email: string | null; role: string; joinedAt: string }[];
  channels: { id: string; type: string; name: string; status: string; lastError: string | null; updatedAt: string }[];
  knowledge: Record<string, number>;
  counts: { products: number; orders: number };
  usage: UsageDay[];
  credits: CreditSummary;
  subscriptions: { id: string; status: string; gateway: string | null; currentPeriodStart: string; currentPeriodEnd: string; createdAt: string }[];
}

export interface Overview {
  tenants: { trial: number; active: number; pastDue: number; suspended: number; outOfCredits: number };
  signups: { last7: number; last30: number };
  today: { customerMessages: number; aiReplies: number; handoffs: number; failedAiCalls: number; errorRate: number };
  aiCostThisMonthUsd: string;
  mrr: { bdt: string; usd: string } | undefined;
  failedPayments: null;
}

export interface ConversationRow {
  id: string;
  workspace: { id: string; name: string };
  channel: { type: string; name: string };
  customerName: string | null;
  mode: 'ai' | 'human';
  status: string;
  handoffReason: string | null;
  flagged: boolean;
  lastMessageAt: string;
  preview: string | null;
  hasFailedReply: boolean;
}

export interface Message {
  id: string;
  direction: 'inbound' | 'outbound';
  kind: 'message' | 'comment' | 'comment_reply' | 'private_reply';
  sender: 'customer' | 'ai' | 'staff' | 'support' | 'system';
  text: string;
  delivery: 'received' | 'pending' | 'sent' | 'failed';
  meta: { sources?: { type: 'chunk' | 'product'; id: string }[]; model?: string; error?: string };
  createdAt: string;
}

export interface ConversationDetail {
  conversation: {
    id: string;
    workspaceId: string;
    mode: 'ai' | 'human';
    status: string;
    handoffReason: string | null;
    flagged: boolean;
    lastMessageAt: string;
    canReply: boolean;
    channel: { id: string; type: string; name: string; status: string };
    customer: { id: string; name: string | null; phone: string | null; address: string | null };
  };
  masked: boolean;
  messages: Message[];
  sources: { chunks: { id: string; content: string; source: string }[]; products: { id: string; title: string; code: string | null; price: string }[] };
}

export interface AuditEntry {
  id: string;
  action: string;
  actor: { id: string; name: string; email: string };
  workspace: { id: string; name: string } | null;
  targetType: string | null;
  targetId: string | null;
  data: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: PlatformRole;
  twoFactor: boolean;
  lastLoginAt: string | null;
  disabledAt: string | null;
  createdAt: string;
}
