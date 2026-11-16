import type { InboundJob } from '@agently/shared';

// The subset of Meta's page webhook payload that Agently reads.
interface MessagingEvent {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: {
    mid: string;
    text?: string;
    is_echo?: boolean;
    attachments?: { type: string; payload?: { url?: string } }[];
  };
  /** Tapping "Get Started" (or another button); carries the m.me ref for a new chat. */
  postback?: { mid?: string; title?: string; payload?: string; referral?: Referral };
  /** messaging_referrals: an m.me link with ?ref= opened in an existing chat. */
  referral?: Referral;
}

interface Referral {
  ref?: string;
  source?: string;
  type?: string;
}

interface FeedChange {
  field: string;
  value: {
    item?: string;
    verb?: string;
    comment_id?: string;
    post_id?: string;
    parent_id?: string;
    message?: string;
    created_time?: number;
    from?: { id: string; name?: string };
  };
}

/** WhatsApp Cloud API: one `messages` change per batch of messages to a phone number. */
interface WhatsAppChange {
  field: string;
  value: {
    messaging_product?: string;
    metadata?: { phone_number_id: string; display_phone_number?: string };
    contacts?: { wa_id: string; profile?: { name?: string } }[];
    messages?: WhatsAppMessage[];
  };
}

interface WhatsAppMessage {
  from: string;
  id: string;
  /** Unix seconds, as a string. */
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; caption?: string };
  video?: { id: string; caption?: string };
  document?: { id: string; caption?: string; filename?: string };
  audio?: { id: string };
  sticker?: { id: string };
  button?: { text?: string; payload?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
}

export interface PageWebhookPayload {
  object: string;
  entry?: { id: string; time: number; messaging?: MessagingEvent[]; changes?: (FeedChange | WhatsAppChange)[] }[];
}

/**
 * Every webhook Agently's Meta app receives: Facebook pages, Instagram
 * accounts and WhatsApp numbers all post to the same callback URL.
 */
export function parseMetaWebhook(payload: PageWebhookPayload): InboundJob[] {
  if (payload.object === 'page') return parsePageWebhook(payload);
  if (payload.object === 'instagram') return parseInstagramWebhook(payload);
  if (payload.object === 'whatsapp_business_account') return parseWhatsAppWebhook(payload);
  return [];
}

/**
 * Instagram DMs (Messenger Platform for Instagram). Same shape as Messenger,
 * with the Instagram account id as the entry id and Instagram-scoped sender ids.
 */
export function parseInstagramWebhook(payload: PageWebhookPayload): InboundJob[] {
  if (payload.object !== 'instagram') return [];
  const jobs: InboundJob[] = [];
  for (const entry of payload.entry ?? []) {
    for (const event of entry.messaging ?? []) {
      const m = event.message;
      // Echoes are the account's own messages, sent by the bot, staff or the Instagram app.
      if (!m || m.is_echo || event.sender.id === entry.id) continue;
      jobs.push({
        channel: 'instagram',
        channelExternalId: entry.id,
        senderExternalId: event.sender.id,
        externalId: m.mid,
        kind: 'message',
        text: m.text ?? '',
        attachments: (m.attachments ?? []).map((a) => ({ type: a.type, url: a.payload?.url })),
        timestamp: event.timestamp,
      });
    }
  }
  return jobs;
}

/** WhatsApp Cloud API messages. Delivery and read statuses are skipped. */
export function parseWhatsAppWebhook(payload: PageWebhookPayload): InboundJob[] {
  if (payload.object !== 'whatsapp_business_account') return [];
  const jobs: InboundJob[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of (entry.changes ?? []) as WhatsAppChange[]) {
      const v = change.value;
      if (change.field !== 'messages' || !v?.metadata?.phone_number_id) continue;
      for (const m of v.messages ?? []) {
        const name = v.contacts?.find((c) => c.wa_id === m.from)?.profile?.name;
        const media = m.image ?? m.video ?? m.document;
        jobs.push({
          channel: 'whatsapp',
          channelExternalId: v.metadata.phone_number_id,
          senderExternalId: m.from,
          ...(name ? { senderName: name } : {}),
          externalId: m.id,
          kind: 'message',
          text: whatsAppText(m),
          // WhatsApp sends media ids, not links; the type is enough for the inbox and the bot.
          attachments: media || m.audio || m.sticker ? [{ type: m.type }] : [],
          timestamp: Number(m.timestamp) * 1000 || Date.now(),
        });
      }
    }
  }
  return jobs;
}

function whatsAppText(m: WhatsAppMessage): string {
  switch (m.type) {
    case 'text':
      return m.text?.body ?? '';
    case 'image':
    case 'video':
    case 'document':
      return m[m.type]?.caption ?? '';
    case 'button':
      return m.button?.text ?? m.button?.payload ?? '';
    case 'interactive':
      return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? '';
    case 'location':
      return m.location ? [m.location.name, m.location.address].filter(Boolean).join(', ') || `Location ${m.location.latitude},${m.location.longitude}` : '';
    default:
      return '';
  }
}

/**
 * Turns a page webhook payload into one job per customer message or new
 * comment. Skips echoes of the page's own messages, comments the page wrote,
 * and edits or deletions.
 */
export function parsePageWebhook(payload: PageWebhookPayload): InboundJob[] {
  if (payload.object !== 'page') return [];
  const jobs: InboundJob[] = [];

  for (const entry of payload.entry ?? []) {
    for (const event of entry.messaging ?? []) {
      const base = { channel: 'facebook_page' as const, channelExternalId: entry.id, senderExternalId: event.sender.id, attachments: [], timestamp: event.timestamp };
      // m.me links: a new chat sends the ref with the Get Started postback, an existing one as a referral.
      if (event.postback) {
        const ref = event.postback.referral?.ref;
        jobs.push({
          ...base,
          externalId: event.postback.mid ?? `postback-${event.sender.id}-${event.timestamp}`,
          kind: 'message',
          text: ref ? '' : (event.postback.title ?? 'Get Started'),
          ...(ref ? { referral: { ref } } : {}),
        });
        continue;
      }
      if (event.referral?.ref) {
        jobs.push({ ...base, externalId: `referral-${event.sender.id}-${event.timestamp}`, kind: 'message', text: '', referral: { ref: event.referral.ref } });
        continue;
      }
      const m = event.message;
      if (!m || m.is_echo) continue;
      jobs.push({
        channel: 'facebook_page',
        channelExternalId: entry.id,
        senderExternalId: event.sender.id,
        externalId: m.mid,
        kind: 'message',
        text: m.text ?? '',
        attachments: (m.attachments ?? []).map((a) => ({ type: a.type, url: a.payload?.url })),
        timestamp: event.timestamp,
      });
    }

    for (const change of (entry.changes ?? []) as FeedChange[]) {
      const v = change.value;
      if (change.field !== 'feed' || v.item !== 'comment' || v.verb !== 'add') continue;
      if (!v.comment_id || !v.from || v.from.id === entry.id) continue;
      jobs.push({
        channel: 'facebook_page',
        channelExternalId: entry.id,
        senderExternalId: v.from.id,
        senderName: v.from.name,
        externalId: v.comment_id,
        kind: 'comment',
        text: v.message ?? '',
        attachments: [],
        postId: v.post_id,
        timestamp: (v.created_time ?? entry.time) * (v.created_time ? 1000 : 1),
      });
    }
  }
  return jobs;
}
