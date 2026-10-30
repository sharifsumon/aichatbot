import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const VERSION = 'v1';

/** Encrypts a secret (page access token, API key) for storage. Output: v1.iv.tag.ciphertext */
export function encryptSecret(plain: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, 'base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join('.');
}

export function decryptSecret(sealed: string, keyBase64: string): string {
  const [version, iv, tag, data] = sealed.split('.');
  if (version !== VERSION || !iv || !tag || !data) throw new Error('Unrecognised secret format');
  const decipher = createDecipheriv(ALGO, Buffer.from(keyBase64, 'base64'), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}
