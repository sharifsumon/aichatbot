import { eq } from 'drizzle-orm';
import { makeTryOn, type TryOnProvider } from '@agently/ai';
import { platformSettings, type Db } from '@agently/db';
import { decryptSecret } from '@agently/shared';

/** The platform_settings row the super admin edits under Platform settings. */
export const TRYON_SERVICE_KEY = 'tryon.service';

/** As stored: the API key only encrypted, plus its last 4 characters to show which key is in use. */
export interface StoredTryOnService {
  provider: 'fashn' | 'gemini';
  model: string;
  mode: string;
  costPerImageUsd: number | null;
  apiKeyEncrypted: string | null;
  apiKeyLast4: string | null;
}

export async function storedTryOnService(db: Db): Promise<StoredTryOnService | undefined> {
  const row = await db.query.platformSettings.findFirst({ where: eq(platformSettings.key, TRYON_SERVICE_KEY) });
  return (row?.value as StoredTryOnService | undefined) ?? undefined;
}

/**
 * The try-on AI to use now: the super admin's settings when they hold a key,
 * otherwise the server's TRYON_* settings (passed in as `fallback`).
 */
export async function currentTryOn(db: Db, encryptionKey: string, fallback?: TryOnProvider): Promise<TryOnProvider | undefined> {
  const s = await storedTryOnService(db);
  if (!s?.apiKeyEncrypted) return fallback;
  return makeTryOn({
    provider: s.provider,
    apiKey: decryptSecret(s.apiKeyEncrypted, encryptionKey),
    model: s.model,
    mode: s.mode,
    costPerImageUsd: s.costPerImageUsd ?? undefined,
  });
}
