import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret } from './crypto.ts';

const key = randomBytes(32).toString('base64');

test('round-trips a secret', () => {
  const sealed = encryptSecret('EAAG-page-token', key);
  assert.notEqual(sealed, 'EAAG-page-token');
  assert.equal(decryptSecret(sealed, key), 'EAAG-page-token');
});

test('rejects a tampered secret', () => {
  const parts = encryptSecret('secret', key).split('.');
  parts[3] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => decryptSecret(parts.join('.'), key));
});

test('rejects the wrong key', () => {
  const sealed = encryptSecret('secret', key);
  assert.throws(() => decryptSecret(sealed, randomBytes(32).toString('base64')));
});
