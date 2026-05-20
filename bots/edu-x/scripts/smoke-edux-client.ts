#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('assert');
const { EduxClient, EDUX_CATEGORY, normalizeEduxCredentials } = require('../lib/edux-client.ts');

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

async function main() {
  const normalized = normalizeEduxCredentials({
    base_url: 'https://edu-x.test/',
    bot_email: 'bot@example.com',
    bot_password: 'pw',
  }, 'smoke');
  assert.equal(normalized.base_url, 'https://edu-x.test');
  assert.equal(normalized._source, 'smoke');

  const calls = [];
  let postAttempts = 0;
  const client = new EduxClient({
    secrets: { base_url: 'https://edu-x.test', bot_email: 'bot@example.com', bot_password: 'pw' },
    sleep: async () => {},
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith('/api/auth/login')) return jsonResponse({ accessToken: 'a1', refreshToken: 'r1' });
      if (String(url).endsWith('/api/auth/refresh')) return jsonResponse({ accessToken: 'a2', refreshToken: 'r2' });
      if (String(url).endsWith('/api/community/posts')) {
        postAttempts += 1;
        if (postAttempts === 1) return jsonResponse({ error: 'expired' }, 401);
        if (postAttempts === 2) return jsonResponse({ retryAfter: 0 }, 429);
        return jsonResponse({ id: 'post-1' });
      }
      return jsonResponse({ ok: true });
    },
  });

  const posted = await client.post({ title: 't'.repeat(210), content: '본문', imageUrl: 'https://img.test/a.png' });
  assert.equal(posted.id, 'post-1');
  const postCall = calls.filter((call) => call.url.endsWith('/api/community/posts')).pop();
  const body = JSON.parse(postCall.options.body);
  assert.equal(body.category, EDUX_CATEGORY);
  assert.equal(body.title.length, 200);
  assert.equal(body.imageUrl, 'https://img.test/a.png');
  assert.equal(postAttempts, 3);

  const noImageClient = new EduxClient({
    secrets: { base_url: 'https://edu-x.test', bot_email: 'bot@example.com', bot_password: 'pw' },
    sleep: async () => {},
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith('/api/auth/login')) return jsonResponse({ accessToken: 'a3', refreshToken: 'r3' });
      if (String(url).endsWith('/api/community/posts')) return jsonResponse({ id: 'post-2' });
      return jsonResponse({ ok: true });
    },
  });
  await noImageClient.post({ title: 'no image', content: '본문' });
  const noImageCall = calls.filter((call) => call.url.endsWith('/api/community/posts')).pop();
  assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(noImageCall.options.body), 'imageUrl'), false);
  console.log(JSON.stringify({ ok: true, calls: calls.length, postAttempts }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
