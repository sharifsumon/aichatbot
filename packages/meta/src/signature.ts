import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Checks Meta's X-Hub-Signature-256 header against the raw request body.
 * Must run on the exact bytes Meta sent, before any JSON parsing.
 */
export function verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice('sha256='.length), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
