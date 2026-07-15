#!/usr/bin/env node
// @ts-nocheck

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const SECRET_STORE = path.join(REPO_ROOT, 'bots', 'hub', 'secrets-store.json');
const FANDING_ORIGIN = 'https://fanding.kr';

export const FANDING_COLLECT_STATUSES = Object.freeze([
  'ok',
  'login_failed',
  'empty_feed',
  'session_expired',
  'dom_changed',
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function normalizePublishedAt(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const isoLike = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}+09:00`;
  const date = new Date(isoLike);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizePost(post = {}) {
  const content = String(post.content || '').trim();
  return {
    sourcePostId: String(post.sourcePostId || post.iPostNo || '').trim(),
    url: String(post.url || '').trim(),
    title: String(post.title || '').trim(),
    publishedAt: normalizePublishedAt(post.publishedAt || post.sInsDatetime),
    content,
    contentSha256: sha256(content),
    isPrivate: post.isPrivate !== false,
    rawMetadata: post.rawMetadata && typeof post.rawMetadata === 'object'
      ? structuredClone(post.rawMetadata)
      : {},
  };
}

export function classifyFandingFailure(input = {}) {
  if (Number(input.httpStatus) === 401 || Number(input.httpStatus) === 403) return 'session_expired';
  if (input.loginAttempted && input.authenticated === false) return 'login_failed';
  if (input.authenticated && input.feedItems === null) return 'dom_changed';
  if (input.authenticated && Array.isArray(input.feedItems) && input.feedItems.length === 0) return 'empty_feed';
  return 'ok';
}

export function dedupeFandingPosts(posts = []) {
  const byKey = new Map();
  for (const post of Array.isArray(posts) ? posts : []) {
    const normalized = normalizePost(post);
    const key = normalized.sourcePostId || normalized.url;
    if (!key) continue;
    byKey.set(key, normalized);
  }
  return [...byKey.values()];
}

export async function mapWithConcurrency(items = [], concurrency = 1, mapper = async (value) => value) {
  const rows = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Math.floor(Number(concurrency) || 1));
  const output = new Array(rows.length);
  let next = 0;
  async function worker() {
    while (next < rows.length) {
      const index = next;
      next += 1;
      output[index] = await mapper(rows[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, rows.length) }, worker));
  return output;
}

export function loadFandingCredentials(secretPath = SECRET_STORE) {
  const store = JSON.parse(fs.readFileSync(secretPath, 'utf8'));
  const credentials = store?.fanding || {};
  const id = String(credentials.id || '').trim();
  const password = String(credentials.password || '');
  const creator = String(credentials.creator || '').trim();
  if (!id || !password || !creator) throw new Error('fanding_credentials_incomplete');
  return { id, password, creator };
}

async function login(page, credentials, timeoutMs) {
  let loginStatus = null;
  const listener = (response) => {
    if (response.url() === `${FANDING_ORIGIN}/rest/login` && response.request().method() === 'POST') {
      loginStatus = response.status();
    }
  };
  page.on('response', listener);
  try {
    await page.goto(`${FANDING_ORIGIN}/account/`, { waitUntil: 'networkidle2', timeout: timeoutMs });
    const email = await page.$('input[type=email]');
    const password = await page.$('input[type=password]');
    if (!email || !password) return { authenticated: false, status: 'dom_changed' };
    await email.type(credentials.id, { delay: 10 });
    await password.type(credentials.password, { delay: 10 });
    const loginResponse = page.waitForResponse(
      (response) => response.url() === `${FANDING_ORIGIN}/rest/login` && response.request().method() === 'POST',
      { timeout: timeoutMs },
    ).catch(() => null);
    await password.press('Enter');
    await loginResponse;
    await sleep(800);
    if (loginStatus === 401 || loginStatus === 403 || page.url().includes('/account')) {
      return { authenticated: false, status: 'login_failed', httpStatus: loginStatus };
    }
    return { authenticated: true, status: 'ok', httpStatus: loginStatus };
  } finally {
    page.off('response', listener);
  }
}

async function resolveCreatorHandle(page, creator, timeoutMs) {
  await page.goto(`${FANDING_ORIGIN}/feeds`, { waitUntil: 'networkidle2', timeout: timeoutMs });
  const feedAuth = await page.evaluate(async () => {
    const response = await fetch('/rest/post_list/feed?iLimit=1');
    return response.status;
  });
  if (feedAuth === 401 || feedAuth === 403) return { status: 'session_expired', handle: null };

  const preview = await page.evaluate(async (searchValue) => {
    const response = await fetch(`/rest/search/preview?sSearchValue=${encodeURIComponent(searchValue)}`);
    return { status: response.status, body: response.ok ? await response.json() : null };
  }, creator);
  if (preview.status === 401 || preview.status === 403) return { status: 'session_expired', handle: null };

  const handle = await page.evaluate((creatorName) => {
    const matching = [...document.querySelectorAll('a[href^="/@"]')]
      .find((anchor) => (anchor.textContent || '').trim() === creatorName);
    return matching?.getAttribute('href')?.match(/^\/@([^/]+)/)?.[1] || null;
  }, creator);
  if (handle) return { status: 'ok', handle };

  function findHandle(value, key = '') {
    if (/^(sMemberUrl|sCreatorUrl|memberUrl|creatorUrl)$/i.test(key)
      && typeof value === 'string'
      && /^[A-Za-z0-9_-]+$/.test(value)) return value;
    if (typeof value === 'string') return value.match(/\/@([A-Za-z0-9_-]+)\/?/)?.[1] || null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findHandle(item);
        if (found) return found;
      }
    } else if (value && typeof value === 'object') {
      for (const [itemKey, item] of Object.entries(value)) {
        const found = findHandle(item, itemKey);
        if (found) return found;
      }
    }
    return null;
  }
  const previewHandle = findHandle(preview.body);
  return previewHandle ? { status: 'ok', handle: previewHandle } : { status: 'dom_changed', handle: null };
}

async function listPostMetadata(page, handle, cutoff, { delayMs, maxPosts }) {
  const posts = [];
  let cursor = null;
  let exhausted = false;
  while (!exhausted && posts.length < maxPosts) {
    const result = await page.evaluate(async ({ memberUrl, lastPostNo }) => {
      const params = new URLSearchParams({
        sMemberUrl: memberUrl,
        iLimit: '24',
        sSortOrder: 'recent',
        sVisibleOnlyOption: 'F',
      });
      if (lastPostNo) params.set('iLastPostNo', String(lastPostNo));
      const response = await fetch(`/rest/post_list?${params.toString()}`);
      return { status: response.status, body: response.ok ? await response.json() : null };
    }, { memberUrl: handle, lastPostNo: cursor });
    if (result.status === 401 || result.status === 403) return { status: 'session_expired', posts: [] };
    const pageRows = result.body?.aData?.aPostList;
    if (!Array.isArray(pageRows)) return { status: 'dom_changed', posts: [] };
    if (pageRows.length === 0) break;

    for (const row of pageRows) {
      const publishedAt = normalizePublishedAt(row.sInsDatetime);
      if (publishedAt && new Date(publishedAt) < cutoff) {
        exhausted = true;
        break;
      }
      posts.push({
        sourcePostId: String(row.iPostNo),
        url: `${FANDING_ORIGIN}/@${handle}/post/${row.iPostNo}/`,
        title: row.sTitle || '',
        publishedAt,
        isPrivate: true,
        rawMetadata: {
          type: row.sType || null,
          contentType: row.sContentType || null,
          isPaidContent: row.sIsPaidContent || null,
          isRead: row.bIsRead ?? null,
        },
      });
      if (posts.length >= maxPosts) break;
    }
    cursor = result.body?.aData?.iLastPostNo || pageRows.at(-1)?.iPostNo || null;
    if (!cursor || pageRows.length < 24) exhausted = true;
    if (!exhausted) await sleep(delayMs);
  }
  return { status: posts.length > 0 ? 'ok' : 'empty_feed', posts };
}

async function collectPostSnapshot(page, post, { delayMs, timeoutMs }) {
  await page.goto(post.url, { waitUntil: 'networkidle2', timeout: timeoutMs });
  if (page.url().includes('/account')) throw Object.assign(new Error('fanding_session_expired'), { code: 'session_expired' });
  const snapshot = await page.evaluate(() => {
    const content = document.querySelector('.main-section__main-text, .fd-editor__content');
    return content ? String(content.innerText || '').trim() : null;
  });
  if (snapshot === null) throw Object.assign(new Error('fanding_post_dom_changed'), { code: 'dom_changed' });
  await sleep(delayMs);
  return normalizePost({ ...post, content: snapshot });
}

export async function upsertFandingPosts(posts = [], runFn = db.run) {
  let written = 0;
  for (const post of dedupeFandingPosts(posts)) {
    await runFn(
      `INSERT INTO investment.jaenong_posts
         (source_post_id, creator, published_at, source_url, title, content_snapshot,
          content_sha256, is_private, collected_at, raw_metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, now(), $8::jsonb)
       ON CONFLICT (source_post_id) DO UPDATE SET
         published_at = EXCLUDED.published_at,
         source_url = EXCLUDED.source_url,
         title = EXCLUDED.title,
         content_snapshot = EXCLUDED.content_snapshot,
         content_sha256 = EXCLUDED.content_sha256,
         is_private = true,
         collected_at = now(),
         raw_metadata = EXCLUDED.raw_metadata,
         updated_at = now()`,
      [
        post.sourcePostId,
        'jaenong',
        post.publishedAt,
        post.url,
        post.title,
        post.content,
        post.contentSha256,
        JSON.stringify(post.rawMetadata || {}),
      ],
    );
    written += 1;
  }
  return written;
}

export async function collectFandingPosts(options = {}, deps = {}) {
  const months = Math.max(6, Math.min(12, Number(options.months || 12) || 12));
  const delayMs = Math.max(750, Number(options.delayMs || 1_250) || 1_250);
  const timeoutMs = Math.max(10_000, Number(options.timeoutMs || 45_000) || 45_000);
  const maxPosts = Math.max(1, Number(options.maxPosts || 2_000) || 2_000);
  const now = options.now ? new Date(options.now) : new Date();
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  const credentials = options.credentials || loadFandingCredentials(options.secretPath);
  const browser = deps.browser || await (deps.launchBrowser || puppeteer.launch)({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const ownsBrowser = !deps.browser;
  let page;
  try {
    page = await browser.newPage();
    const auth = await login(page, credentials, timeoutMs);
    if (!auth.authenticated) return { status: auth.status, posts: [], written: 0 };
    const creator = await resolveCreatorHandle(page, credentials.creator, timeoutMs);
    if (!creator.handle) return { status: creator.status, posts: [], written: 0 };
    const listed = await listPostMetadata(page, creator.handle, cutoff, { delayMs, maxPosts });
    if (listed.status !== 'ok') return { status: listed.status, posts: [], written: 0 };

    const posts = await mapWithConcurrency(listed.posts, 1, (post) => (
      collectPostSnapshot(page, post, { delayMs, timeoutMs })
    ));
    const normalized = dedupeFandingPosts(posts);
    const written = options.write === true
      ? await upsertFandingPosts(normalized, deps.runFn || db.run)
      : 0;
    return {
      status: normalized.length > 0 ? 'ok' : 'empty_feed',
      posts: normalized,
      written,
      months,
      cutoff: cutoff.toISOString(),
      privateSnapshot: true,
    };
  } catch (error) {
    const status = error?.code === 'session_expired'
      ? 'session_expired'
      : error?.code === 'dom_changed'
        ? 'dom_changed'
        : 'dom_changed';
    return { status, posts: [], written: 0, error: String(error?.message || error) };
  } finally {
    await page?.close().catch(() => null);
    if (ownsBrowser) await browser.close().catch(() => null);
  }
}

function parseArgs(argv = process.argv.slice(2)) {
  const value = (name, fallback) => {
    const arg = argv.find((item) => item.startsWith(`--${name}=`));
    return arg ? arg.slice(name.length + 3) : fallback;
  };
  return {
    months: Number(value('months', 12)),
    maxPosts: Number(value('limit', 2_000)),
    write: argv.includes('--write'),
    json: argv.includes('--json'),
  };
}

if (isDirectExecution(import.meta.url)) {
  void runCliMain({
    run: () => collectFandingPosts(parseArgs()),
    onSuccess: (result) => {
      const summary = {
        status: result.status,
        collected: result.posts?.length || 0,
        written: result.written || 0,
        cutoff: result.cutoff || null,
        privateSnapshot: result.privateSnapshot === true,
        error: result.error || null,
      };
      console.log(JSON.stringify(summary, null, 2));
      if (result.status !== 'ok') process.exitCode = 2;
    },
    errorPrefix: 'fanding collector failed:',
  });
}
