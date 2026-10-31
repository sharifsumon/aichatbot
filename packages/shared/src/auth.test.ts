import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base32Decode, base32Encode, hashPassword, passwordProblem, totpCode, totpStep, verifyPassword, verifyTotp } from './index.ts';

test('passwords: scrypt hash verifies, wrong password and junk do not', async () => {
  const stored = await hashPassword('correct horse battery');
  assert.match(stored, /^scrypt\$32768\$8\$1\$/);
  assert.equal(await verifyPassword('correct horse battery', stored), true);
  assert.equal(await verifyPassword('correct horse batterz', stored), false);
  assert.equal(await verifyPassword('x', 'not-a-hash'), false);
  assert.notEqual(await hashPassword('correct horse battery'), stored);
  assert.ok(passwordProblem('short'));
  assert.equal(passwordProblem('long enough passphrase'), undefined);
});

test('TOTP matches the RFC 6238 SHA-1 test vectors', () => {
  // RFC 6238 appendix B, secret "12345678901234567890", 8 digits there; the last 6 here.
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(base32Decode(secret).toString(), '12345678901234567890');
  const vectors: [number, string][] = [
    [59, '287082'],
    [1111111109, '081804'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ];
  for (const [t, code] of vectors) assert.equal(totpCode(secret, totpStep(t * 1000)), code);
});

test('TOTP allows one step of drift and refuses replays', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  const now = 1234567890 * 1000;
  const step = totpStep(now);
  assert.equal(verifyTotp(secret, totpCode(secret, step), { now }), step);
  assert.equal(verifyTotp(secret, totpCode(secret, step - 1), { now }), step - 1);
  assert.equal(verifyTotp(secret, totpCode(secret, step - 2), { now }), undefined);
  assert.equal(verifyTotp(secret, totpCode(secret, step), { now, lastUsedStep: step }), undefined);
  assert.equal(verifyTotp(secret, '12345', { now }), undefined);
  assert.equal(verifyTotp(secret, `${totpCode(secret, step).slice(0, 3)} ${totpCode(secret, step).slice(3)}`, { now }), step);
});
