import { test } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';
process.env.API_KEY = '';
// Avoid touching the host's data/ dir (may be owned by the container user):
// run from a throwaway temp dir so data/qwenproxy.db and .encryption_key are
// created fresh and writable. ENCRYPTION_KEY bypasses the key file entirely.
process.env.ENCRYPTION_KEY = 'test-encryption-key';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwenproxy-test-'));
process.chdir(tempDir);

const { isRateLimitError, getRateLimitHintHours } = await import('../services/error-handler.js');
const { parseQwenErrorObject } = await import('../routes/sse-parser.js');
const { getNextAccount, getNextAvailableAccount, markAccountRateLimitedByMessage, clearAccountCooldown, getAccountCooldownInfo, invalidateAccountsCache } = await import('../core/account-manager.js');
const { addAccount, removeAccount } = await import('../core/accounts.js');

test('isRateLimitError detects every rate-limit error shape', () => {
  // Canonical QwenUpstreamError
  assert.ok(isRateLimitError({ upstreamCode: 'RateLimited', upstreamStatus: 429, message: 'Wait about 24 hour(s)' }));
  // Plain HTTP 429 without structured fields
  assert.ok(isRateLimitError({ message: 'Failed to fetch from Qwen: 429 Too Many Requests' }));
  // Non-canonical codes
  assert.ok(isRateLimitError({ upstreamCode: 'TooManyRequests', message: 'Too many requests' }));
  assert.ok(isRateLimitError({ upstreamCode: 'DAILY_LIMIT_EXCEEDED', message: "You've reached the daily limit for today's usage." }));
  // Bare "limit" must NOT match (deliberate): Qwen also uses *limit* codes
  // for per-request context-length errors, which must not lock an account.
  assert.ok(!isRateLimitError({ upstreamCode: 'DAILY_LIMIT_EXCEEDED', message: 'limit' }));
  // Message-only signals (generic Error wrapping a 429)
  assert.ok(isRateLimitError({ message: "You've reached the upper limit for today's usage." }));
  assert.ok(isRateLimitError({ message: 'Browser stream fetch returned non-stream response without body: 429' }));
  // Non rate-limit errors must NOT match
  assert.ok(!isRateLimitError({ upstreamStatus: 500, message: 'Internal server error' }));
  assert.ok(!isRateLimitError({ message: 'Bad_Request: invalid parameter' }));
  assert.ok(!isRateLimitError(null));
});

test('getRateLimitHintHours parses Qwen wait hint and falls back to null', () => {
  assert.strictEqual(getRateLimitHintHours('Qwen upstream error: RateLimited: limit. Wait about 3 hour(s) before trying again.'), 3);
  assert.strictEqual(getRateLimitHintHours('Qwen upstream error: RateLimited: limit.'), null);
  assert.strictEqual(getRateLimitHintHours(undefined), null);
});

test('parseQwenErrorObject classifies the canonical RateLimited payload', () => {
  const err = parseQwenErrorObject({
    success: false,
    data: {
      code: 'RateLimited',
      details: "You've reached the upper limit for today's usage.",
      num: 24,
    },
  });
  assert.ok(err);
  assert.strictEqual(err!.status, 429);
  assert.match(err!.message, /Qwen upstream error: RateLimited/);
  assert.match(err!.message, /Wait about 24 hour\(s\)/);

  // Non-error chunks return null
  assert.strictEqual(parseQwenErrorObject({ choices: [{ delta: { content: 'hi' } }] }), null);
  assert.strictEqual(parseQwenErrorObject(null), null);
});

test('markAccountRateLimitedByMessage honors the hour hint for cooldown', async () => {
  const email = 'ratelimit-cooldown@test.com';
  let accountId = '';
  try {
    const acct = addAccount(email, 'password123');
    accountId = acct.id;
    invalidateAccountsCache();

    markAccountRateLimitedByMessage(accountId, 'Qwen upstream error: RateLimited: limit. Wait about 3 hour(s) before trying again.');

    const info = getAccountCooldownInfo(accountId);
    assert.ok(info, 'account should be on cooldown');
    assert.strictEqual(info!.reason, 'RateLimited');
    // ~3h, allow small clock skew
    assert.ok(info!.remainingMs > 3 * 60 * 60 * 1000 - 5000 && info!.remainingMs <= 3 * 60 * 60 * 1000);
  } finally {
    if (accountId) clearAccountCooldown(accountId);
    if (accountId) removeAccount(accountId);
    invalidateAccountsCache();
  }
});

test('Rotation skips rate-limited accounts and returns the available one', async () => {
  const mockAccounts = [
    { email: 'rl-rotation-1@test.com', password: 'p1' },
    { email: 'rl-rotation-2@test.com', password: 'p2' },
    { email: 'rl-rotation-3@test.com', password: 'p3' },
  ];
  const ids: string[] = [];
  try {
    for (const acc of mockAccounts) ids.push(addAccount(acc.email, acc.password).id);
    invalidateAccountsCache();

    // Two accounts hit the daily limit, one stays free
    markAccountRateLimitedByMessage(ids[0], 'Wait about 24 hour(s)');
    markAccountRateLimitedByMessage(ids[1], 'Wait about 24 hour(s)');

    // Every pick must be the free account
    for (let i = 0; i < 5; i++) {
      const picked = getNextAccount();
      assert.ok(picked, 'should always find an available account');
      assert.strictEqual(picked!.id, ids[2], 'rotation must skip rate-limited accounts');
    }

    // getNextAvailableAccount behaves the same
    const viaAvailable = getNextAvailableAccount(new Set<string>());
    assert.strictEqual(viaAvailable!.id, ids[2]);
  } finally {
    for (const id of ids) {
      clearAccountCooldown(id);
      removeAccount(id);
    }
    invalidateAccountsCache();
  }
});