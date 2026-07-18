'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

describe('shared limiter lease fencing', () => {
  let limiterDir;
  let limiter;

  beforeEach(() => {
    jest.resetModules();
    limiterDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-lease-test-'));
    process.env.HUB_LLM_SHARED_LIMITER_DIR = limiterDir;
    process.env.HUB_LLM_SHARED_LIMITER_BACKEND = 'file';
    process.env.HUB_LLM_SHARED_LEASE_TTL_MS = '60000';
    limiter = require('../lib/llm/shared-limiter.ts');
  });

  afterEach(() => {
    jest.useRealTimers();
    limiter?.resetSharedLimiterForTests();
    fs.rmSync(limiterDir, { recursive: true, force: true });
    delete process.env.HUB_LLM_SHARED_LIMITER_DIR;
    delete process.env.HUB_LLM_SHARED_LIMITER_BACKEND;
    delete process.env.HUB_LLM_SHARED_LEASE_TTL_MS;
    delete process.env.HUB_LLM_SHARED_LEASE_RENEW_MS;
    delete process.env.HUB_LLM_SHARED_TEAM_MAX_IN_FLIGHT;
  });

  test('renews only the current owner lease', () => {
    const lease = limiter._testOnly.acquireFileScopeLease('provider:groq', 1, 1_000);
    expect(lease.ok).toBe(true);
    const before = JSON.parse(fs.readFileSync(lease.file, 'utf8'));
    expect(before.leaseId).toBe(lease.leaseId);

    expect(limiter._testOnly.renewFileScopeLease(lease.file, lease.leaseId, 2_000)).toBe(true);
    const renewed = JSON.parse(fs.readFileSync(lease.file, 'utf8'));
    expect(renewed.expiresAt).toBeGreaterThan(before.expiresAt);

    expect(limiter._testOnly.renewFileScopeLease(lease.file, 'stale-owner', 3_000)).toBe(false);
  });

  test('stale owner release cannot remove a replacement lease', () => {
    const lease = limiter._testOnly.acquireFileScopeLease('provider:openai-oauth', 1, 1_000);
    expect(lease.ok).toBe(true);
    fs.writeFileSync(lease.file, JSON.stringify({
      scope: 'provider:openai-oauth',
      leaseId: 'replacement-owner',
      expiresAt: Date.now() + 60_000,
    }));

    lease.release();
    expect(fs.existsSync(lease.file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lease.file, 'utf8')).leaseId).toBe('replacement-owner');
  });

  test('renews an active composite lease before its ttl even with an unsafe interval override', async () => {
    jest.resetModules();
    jest.useFakeTimers({ now: 1_000 });
    process.env.HUB_LLM_SHARED_LEASE_TTL_MS = '1000';
    process.env.HUB_LLM_SHARED_LEASE_RENEW_MS = '5000';
    limiter = require('../lib/llm/shared-limiter.ts');

    const lease = await limiter.acquireSharedLimiterLease({ team: 'blog', provider: 'openai-oauth' });
    expect(lease.ok).toBe(true);
    const file = path.join(limiterDir, 'global', '0.lease');
    const before = JSON.parse(fs.readFileSync(file, 'utf8'));

    await jest.advanceTimersByTimeAsync(550);

    const renewed = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(renewed.expiresAt).toBeGreaterThan(before.expiresAt);
    expect(lease.isValid()).toBe(true);
    lease.release();
  });

  test('does not lose an active lease during transient file-lock contention', async () => {
    jest.resetModules();
    jest.useFakeTimers({ now: 1_000 });
    process.env.HUB_LLM_SHARED_LEASE_TTL_MS = '1000';
    process.env.HUB_LLM_SHARED_LEASE_RENEW_MS = '250';
    limiter = require('../lib/llm/shared-limiter.ts');

    const lease = await limiter.acquireSharedLimiterLease({ team: 'blog', provider: 'openai-oauth' });
    expect(lease.ok).toBe(true);
    const file = path.join(limiterDir, 'global', '0.lease');
    const lockFile = `${file}.lock`;
    fs.writeFileSync(lockFile, JSON.stringify({ lockId: 'contender', expiresAt: 1_600 }));

    await jest.advanceTimersByTimeAsync(300);

    expect(lease.isValid()).toBe(true);
    expect(lease.signal.aborted).toBe(false);
    fs.unlinkSync(lockFile);
    const before = JSON.parse(fs.readFileSync(file, 'utf8'));

    await jest.advanceTimersByTimeAsync(300);

    const renewed = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(renewed.expiresAt).toBeGreaterThan(before.expiresAt);
    await lease.release();
  });

  test('surfaces a composite release failure instead of silently accepting it', async () => {
    const lease = await limiter.acquireSharedLimiterLease({ team: 'blog', provider: 'openai-oauth' });
    expect(lease.ok).toBe(true);
    const leaseFiles = [
      path.join(limiterDir, 'global', '0.lease'),
      path.join(limiterDir, 'team:blog', '0.lease'),
      path.join(limiterDir, 'provider:openai-oauth', '0.lease'),
    ];
    for (const file of leaseFiles) {
      fs.writeFileSync(`${file}.lock`, JSON.stringify({
        lockId: 'contender',
        expiresAt: Date.now() + 60_000,
      }));
    }

    await expect(lease.release()).rejects.toThrow('shared_limiter_file_release_failed');
  });

  test('shares one admission team limit across luna and investment aliases', async () => {
    process.env.HUB_LLM_SHARED_TEAM_MAX_IN_FLIGHT = '1';
    const lunaLease = await limiter.acquireSharedLimiterLease({ team: 'luna', provider: 'groq' });
    expect(lunaLease.ok).toBe(true);

    const investmentLease = await limiter.acquireSharedLimiterLease({
      team: 'investment',
      provider: 'openai-oauth',
    });

    expect(investmentLease).toMatchObject({
      ok: false,
      reason: 'shared_limiter_full',
      scope: 'team:investment',
    });
    await lunaLease.release();
  });

  test('rejects a composite lease when an earlier scope is no longer owned', async () => {
    const released = [];
    const leaseByScope = new Map([
      ['global', {
        ok: true,
        scope: 'global',
        limit: 1,
        renew: async () => false,
        release: async () => { released.push('global'); },
      }],
      ['team:blog', {
        ok: true,
        scope: 'team:blog',
        limit: 1,
        renew: async () => true,
        release: async () => { released.push('team:blog'); },
      }],
      ['provider:groq', {
        ok: true,
        scope: 'provider:groq',
        limit: 1,
        renew: async () => true,
        release: async () => { released.push('provider:groq'); },
      }],
    ]);

    const result = await limiter.acquireSharedLimiterLease({ team: 'blog', provider: 'groq' }, {
      acquireScopeLease: async (scope) => leaseByScope.get(scope),
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'shared_limiter_lease_lost',
      scope: 'global',
    });
    expect(released.sort()).toEqual(['global', 'provider:groq', 'team:blog']);
  });

  test('fails closed when partial acquisition rollback cannot release a lease', async () => {
    const result = await limiter.acquireSharedLimiterLease({ team: 'blog', provider: 'groq' }, {
      acquireScopeLease: async (scope) => {
        if (scope === 'global') {
          return {
            ok: true,
            scope,
            limit: 1,
            renew: async () => true,
            release: async () => { throw new Error('release unavailable'); },
          };
        }
        return {
          ok: false,
          scope,
          limit: 1,
          reason: 'shared_limiter_full',
          retryAfterMs: 1_000,
        };
      },
      releaseAttempts: 2,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'shared_limiter_release_failed',
      cleanupUncertain: true,
    });
  });
});
