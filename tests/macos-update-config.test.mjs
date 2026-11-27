import assert from 'node:assert/strict';
import test from 'node:test';
import { macOSUpdateConfiguration } from '../scripts/macos-update-config.mjs';

test('macOS の更新では有効な Ed25519 公開鍵を必須にする', () => {
  const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString('base64');
  const settings = macOSUpdateConfiguration(`\n${key}\n`);
  assert.equal(settings.SUPublicEDKey, key);
  assert.equal(settings.SURequireSignedFeed, true);
  assert.equal(settings.SUVerifyUpdateBeforeExtraction, true);
  assert.equal(settings.SUEnableAutomaticChecks, true);
  assert.equal(settings.SUAutomaticallyUpdate, true);
  for (const invalid of ['', 'not a key', `${key}!`, key.slice(0, -1), Buffer.alloc(31).toString('base64'), Buffer.alloc(64).toString('base64')]) {
    assert.throws(() => macOSUpdateConfiguration(invalid), /32-byte Ed25519/);
  }
});
