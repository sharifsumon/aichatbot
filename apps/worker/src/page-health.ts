import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { activities, channels } from '@agently/db';
import { GraphApiError } from '@agently/meta';
import { decryptSecret } from '@agently/shared';
import type { WorkerDeps } from './deps.ts';

/**
 * Facebook stops sending a page's messages, without telling anyone, once its
 * token is revoked (the owner removed the app or a page permission). Checks
 * each connected page's token, marks a dead one "needs reconnecting" so the
 * dashboard says so, and notes it in the shop's activity feed once.
 */
export async function checkPageTokens(deps: Pick<WorkerDeps, 'db' | 'graph' | 'encryptionKey' | 'log'>): Promise<{ checked: number; expired: number }> {
  const rows = await deps.db
    .select({ id: channels.id, type: channels.type, externalId: channels.externalId, workspaceId: channels.workspaceId, name: channels.name, token: channels.accessTokenEncrypted })
    .from(channels)
    .where(and(inArray(channels.type, ['facebook_page', 'instagram', 'whatsapp']), eq(channels.status, 'connected'), isNotNull(channels.accessTokenEncrypted)));
  let expired = 0;
  for (const ch of rows) {
    try {
      const token = decryptSecret(ch.token!, deps.encryptionKey);
      // Instagram answers with its page's token; WhatsApp with the number's own.
      if (ch.type === 'whatsapp') await deps.graph.whatsAppNumber(token, ch.externalId);
      else await deps.graph.checkPageToken(token);
    } catch (err) {
      // Outages and rate limits say nothing about the token; check again next hour.
      if (!(err instanceof GraphApiError) || !err.tokenInvalid) {
        deps.log.warn({ err, channelId: ch.id }, 'Page token check failed');
        continue;
      }
      expired++;
      await deps.db.update(channels).set({ status: 'token_expired', lastError: err.message }).where(eq(channels.id, ch.id));
      await deps.db.insert(activities).values({
        workspaceId: ch.workspaceId,
        type: 'channel.token_expired',
        text: `${ch.name} needs reconnecting: ${ch.type === 'whatsapp' ? 'WhatsApp' : ch.type === 'instagram' ? 'Instagram' : 'Facebook'} stopped sending its messages`,
        data: { channelId: ch.id },
      });
    }
  }
  return { checked: rows.length, expired };
}
