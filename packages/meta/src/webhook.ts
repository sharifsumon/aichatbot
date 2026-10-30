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

export interface PageWebhookPayload {
  object: string;
  entry?: { id: string; time: number; messaging?: MessagingEvent[]; changes?: FeedChange[] }[];
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

    for (const change of entry.changes ?? []) {
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
