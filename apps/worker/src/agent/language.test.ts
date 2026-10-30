import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage } from './language.ts';

test('detects Bangla, Banglish and English', () => {
  assert.equal(detectLanguage('এই শার্টের দাম কত?'), 'bn');
  assert.equal(detectLanguage('vai ei shirt er dam koto?'), 'banglish');
  assert.equal(detectLanguage('XL size ache?'), 'banglish');
  assert.equal(detectLanguage('How much is this shirt?'), 'en');
  assert.equal(detectLanguage('M size দাম কত'), 'bn');
});
