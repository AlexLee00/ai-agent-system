'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');

const pgPool = require('../../../packages/core/lib/pg-pool');
const env = require('../../../packages/core/lib/env');
const { LOCAL_MODEL_FAST, callLocalLLMJSON } = require('../../../packages/core/lib/local-llm-client');
const { postAlarm } = require('../../../packages/core/lib/openclaw-client');
const { parseNaverBlogUrl } = require('../../../packages/core/lib/naver-blog-url');
const { getBlogCommenterConfig } = require('./runtime-config');

const TABLE = 'blog.comments';
const ACTION_TABLE = 'blog.comment_actions';
const DEFAULT_SUMMARY_LEN = 220;
const BROWSER_CONNECT_TIMEOUT_MS = 5000;
const NAVER_NAVIGATION_TIMEOUT_MS = 45000;

function nowKstHour() {
  return Number(new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' })).getHours());
}

function expandHome(value) {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

function readOpenClawGatewayTokenFromConfig() {
  try {
    const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return String(parsed?.gateway?.auth?.token || '').trim();
  } catch {
    return '';
  }
}

function getCommenterConfig() {
  const runtime = getBlogCommenterConfig();
  const browserToken = String(
    runtime.browserToken
    || process.env.OPENCLAW_BROWSER_TOKEN
    || process.env.OPENCLAW_GATEWAY_TOKEN
    || readOpenClawGatewayTokenFromConfig()
    || ''
  ).trim();
  return {
    enabled: runtime.enabled === true,
    blogId: String(runtime.blogId || '').trim(),
    maxDaily: Number(runtime.maxDaily || 20),
    activeStartHour: Number(runtime.activeStartHour || 8),
    activeEndHour: Number(runtime.activeEndHour || 22),
    browserHttpUrl: String(runtime.browserHttpUrl || '').trim(),
    browserWsEndpoint: String(runtime.browserWsEndpoint || '').trim(),
    browserToken,
    profileDir: expandHome(runtime.profileDir || path.join(env.OPENCLAW_WORKSPACE, 'naver-profile')),
    pageReadMinSec: Number(runtime.pageReadMinSec || 30),
    pageReadMaxSec: Number(runtime.pageReadMaxSec || 90),
    typingMinSec: Number(runtime.typingMinSec || 20),
    typingMaxSec: Number(runtime.typingMaxSec || 45),
    betweenCommentsMinSec: Number(runtime.betweenCommentsMinSec || 60),
    betweenCommentsMaxSec: Number(runtime.betweenCommentsMaxSec || 180),
    minReplyLen: Number(runtime.minReplyLen || 30),
    maxReplyLen: Number(runtime.maxReplyLen || 200),
    maxDetectPerCycle: Number(runtime.maxDetectPerCycle || 20),
    maxProcessPerCycle: Number(runtime.maxProcessPerCycle || 20),
  };
}

async function inferBlogIdFromPublishedPosts() {
  try {
    const row = await pgPool.get('blog', `
      SELECT naver_url
      FROM blog.posts
      WHERE naver_url IS NOT NULL
        AND naver_url <> ''
      ORDER BY created_at DESC
      LIMIT 1
    `);
    if (!row?.naver_url) return '';
    const parsed = parseNaverBlogUrl(row.naver_url);
    return parsed.ok ? parsed.blogId : '';
  } catch {
    return '';
  }
}

async function resolveBlogId() {
  const config = getCommenterConfig();
  if (config.blogId) return config.blogId;
  return inferBlogIdFromPublishedPosts();
}

function buildDedupeKey(postUrl, commenterId, commentText) {
  const raw = [String(postUrl || '').trim(), String(commenterId || '').trim(), String(commentText || '').trim()].join('|');
  return crypto.createHash('sha1').update(raw).digest('hex');
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .trim();
}

function squeezeText(value, maxLen = DEFAULT_SUMMARY_LEN) {
  const normalized = normalizeText(value);
  if (!normalized) return '';
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen - 1)}…`;
}

function isWithinActiveWindow(config = getCommenterConfig()) {
  const hour = nowKstHour();
  return hour >= config.activeStartHour && hour <= config.activeEndHour;
}

function calcDelayMs(minSec, maxSec, testMode = false) {
  const min = Number(minSec || 0);
  const max = Number(maxSec || min);
  const factor = testMode ? 0.03 : 1;
  const jitter = min + Math.random() * Math.max(0, max - min);
  return Math.round(jitter * 1000 * factor);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function humanDelay(minSec, maxSec, testMode = false) {
  const delayMs = calcDelayMs(minSec, maxSec, testMode);
  if (delayMs > 0) {
    await sleep(delayMs);
  }
}

async function ensureSchema() {
  await pgPool.run('blog', `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id SERIAL PRIMARY KEY,
      post_url TEXT NOT NULL,
      post_title TEXT,
      commenter_id TEXT,
      commenter_name TEXT,
      comment_text TEXT NOT NULL,
      comment_ref TEXT,
      dedupe_key TEXT NOT NULL UNIQUE,
      reply_text TEXT,
      reply_at TIMESTAMPTZ,
      detected_at TIMESTAMPTZ DEFAULT NOW(),
      status TEXT DEFAULT 'pending',
      error_message TEXT,
      meta JSONB DEFAULT '{}'::JSONB
    )
  `);
  await pgPool.run('blog', `CREATE INDEX IF NOT EXISTS idx_comments_status ON ${TABLE}(status)`);
  await pgPool.run('blog', `CREATE INDEX IF NOT EXISTS idx_comments_detected ON ${TABLE}(detected_at DESC)`);
  await pgPool.run('blog', `
    CREATE TABLE IF NOT EXISTS ${ACTION_TABLE} (
      id SERIAL PRIMARY KEY,
      action_type TEXT NOT NULL,
      target_blog TEXT,
      target_post_url TEXT,
      comment_text TEXT,
      success BOOLEAN DEFAULT true,
      executed_at TIMESTAMPTZ DEFAULT NOW(),
      meta JSONB DEFAULT '{}'::JSONB
    )
  `);
}

async function recordCommentAction(actionType, payload = {}) {
  await pgPool.run('blog', `
    INSERT INTO ${ACTION_TABLE} (action_type, target_blog, target_post_url, comment_text, success, meta)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb)
  `, [
    actionType,
    payload.targetBlog || null,
    payload.targetPostUrl || null,
    payload.commentText || null,
    payload.success !== false,
    JSON.stringify(payload.meta || {}),
  ]);
}

async function getTodayReplyCount() {
  const row = await pgPool.get('blog', `
    SELECT COUNT(*) AS count
    FROM ${TABLE}
    WHERE status = 'replied'
      AND timezone('Asia/Seoul', reply_at)::date = timezone('Asia/Seoul', now())::date
  `);
  return Number(row?.count || 0);
}

async function getPendingComments(limit = 20) {
  return pgPool.query('blog', `
    SELECT *
    FROM ${TABLE}
    WHERE status = 'pending'
    ORDER BY detected_at ASC
    LIMIT $1
  `, [limit]);
}

async function updateCommentStatus(id, status, options = {}) {
  const fields = [
    'status = $2',
    'reply_text = COALESCE($3, reply_text)',
    'error_message = $4',
    'reply_at = CASE WHEN $2 = \'replied\' THEN NOW() ELSE reply_at END',
    'meta = COALESCE(meta, \'{}\'::jsonb) || $5::jsonb',
  ];
  await pgPool.run('blog', `
    UPDATE ${TABLE}
    SET ${fields.join(', ')}
    WHERE id = $1
  `, [
    id,
    status,
    options.replyText || null,
    options.errorMessage || null,
    JSON.stringify(options.meta || {}),
  ]);
}

async function saveDetectedComment(comment) {
  const dedupeKey = buildDedupeKey(comment.postUrl, comment.commenterId, comment.commentText);
  const result = await pgPool.run('blog', `
    INSERT INTO ${TABLE} (
      post_url, post_title, commenter_id, commenter_name,
      comment_text, comment_ref, dedupe_key, meta
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING id
  `, [
    comment.postUrl,
    comment.postTitle || null,
    comment.commenterId || null,
    comment.commenterName || null,
    comment.commentText,
    comment.commentRef || null,
    dedupeKey,
    JSON.stringify(comment.meta || {}),
  ]);

  if (result.rowCount > 0) {
    return { inserted: true, id: result.rows[0].id, dedupeKey };
  }
  return { inserted: false, dedupeKey };
}

async function fetchManagedBrowserWsEndpoint(config) {
  if (config.browserWsEndpoint) return config.browserWsEndpoint;
  if (!config.browserHttpUrl) return '';

  const baseUrl = config.browserHttpUrl.replace(/\/+$/, '');
  const headers = {};
  const token = config.browserToken;
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const statusRes = await fetch(`${baseUrl}/`, {
      headers,
      signal: AbortSignal.timeout(BROWSER_CONNECT_TIMEOUT_MS),
    });
    if (statusRes.ok) {
      const status = await statusRes.json();
      const cdpUrl = String(status?.cdpUrl || '').trim();
      const ready = status?.running === true && status?.cdpReady === true && !!cdpUrl;
      if (!ready) {
        const reason = status?.running === false
          ? 'managed_browser_not_running'
          : 'managed_browser_not_ready';
        const error = new Error(reason);
        error.code = reason;
        throw error;
      }

      const cdpVersionRes = await fetch(`${cdpUrl.replace(/\/+$/, '')}/json/version`, {
        signal: AbortSignal.timeout(BROWSER_CONNECT_TIMEOUT_MS),
      });
      if (cdpVersionRes.ok) {
        const cdpVersion = await cdpVersionRes.json();
        if (cdpVersion?.webSocketDebuggerUrl) {
          return cdpVersion.webSocketDebuggerUrl;
        }
      }
    }
  } catch (error) {
    if (env.IS_OPS || token) {
      throw error;
    }
  }

  const candidates = [
    `${baseUrl}/json/version`,
    token ? `${baseUrl}/json/version?token=${encodeURIComponent(token)}` : '',
  ].filter(Boolean);

  for (const target of candidates) {
    try {
      const res = await fetch(target, {
        headers,
        signal: AbortSignal.timeout(BROWSER_CONNECT_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const json = await res.json();
      if (json?.webSocketDebuggerUrl) {
        return json.webSocketDebuggerUrl;
      }
    } catch {
      // try next
    }
  }

  return '';
}

async function connectBrowser(testMode = false) {
  const config = getCommenterConfig();
  const wsEndpoint = await fetchManagedBrowserWsEndpoint(config);
  if (wsEndpoint) {
    const browser = await puppeteer.connect({
      browserWSEndpoint: wsEndpoint,
      protocolTimeout: testMode ? 15000 : 60000,
    });
    return { browser, managed: true, mode: 'connect' };
  }

  if (env.IS_OPS && config.browserHttpUrl) {
    const error = new Error('managed_browser_required');
    error.code = 'managed_browser_required';
    throw error;
  }

  const browser = await puppeteer.launch({
    headless: false,
    pipe: false,
    defaultViewport: null,
    protocolTimeout: testMode ? 15000 : 60000,
    userDataDir: config.profileDir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--window-position=0,25',
      '--window-size=1600,1100',
    ],
  });
  return { browser, managed: false, mode: 'launch' };
}

async function disconnectBrowser(handle) {
  if (!handle?.browser) return;
  if (handle.managed) {
    await handle.browser.disconnect();
    return;
  }
  await handle.browser.close();
}

async function withBrowserPage(testMode, fn) {
  const handle = await connectBrowser(testMode);
  const page = await handle.browser.newPage();
  page.setDefaultNavigationTimeout(testMode ? 15000 : NAVER_NAVIGATION_TIMEOUT_MS);
  page.setDefaultTimeout(testMode ? 10000 : 30000);
  try {
    return await fn(page, handle);
  } finally {
    try {
      await page.close();
    } catch {
      // ignore
    }
    await disconnectBrowser(handle);
  }
}

async function goto(page, url) {
  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: NAVER_NAVIGATION_TIMEOUT_MS,
  });
}

async function extractAdminComments(page, limit = 20) {
  return page.evaluate((maxItems) => {
    function textOf(el) {
      return String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function pickText(root, selectors) {
      for (const selector of selectors) {
        const node = root.querySelector(selector);
        const text = textOf(node);
        if (text) return text;
      }
      return '';
    }

    function visible(el) {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }

    function getReplyState(rootText) {
      if (/답글\s*완료|답변\s*완료|답글\s*등록됨/i.test(rootText)) return 'replied';
      if (/답글|답변|등록/i.test(rootText)) return 'pending';
      return 'unknown';
    }

    const selectors = [
      'li[class*="comment"]',
      'div[class*="comment"]',
      'tr',
      'li',
    ];
    const roots = [];
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        if (!visible(node)) continue;
        const text = textOf(node);
        if (text.length < 10 || text.length > 1200) continue;
        if (!/(답글|댓글|답변)/.test(text)) continue;
        const anchor = node.querySelector('a[href*="blog.naver.com"], a[href*="m.blog.naver.com"], a[href*="PostView.naver"]');
        if (!anchor) continue;
        roots.push(node);
      }
    }

    const deduped = Array.from(new Set(roots)).slice(0, maxItems * 3);
    const results = [];

    for (const root of deduped) {
      const rootText = textOf(root);
      const state = getReplyState(rootText);
      if (state !== 'pending') continue;

      const anchorCandidates = Array.from(root.querySelectorAll('a[href*="blog.naver.com"], a[href*="m.blog.naver.com"], a[href*="PostView.naver"]'));
      const postAnchor = anchorCandidates.sort((a, b) => textOf(b).length - textOf(a).length)[0];
      const postUrl = postAnchor?.href || '';
      const postTitle = textOf(postAnchor);

      const commenterName = pickText(root, ['strong', '.nick', '.nickname', '.name', '.writer']);
      const commentText = pickText(root, ['.comment_text', '.text', '.desc', 'p', 'span']);
      const commentRef = root.getAttribute('data-comment-id')
        || root.getAttribute('data-comment-no')
        || root.getAttribute('data-log-no')
        || root.id
        || '';

      if (!postUrl || !commentText) continue;

      results.push({
        postUrl,
        postTitle,
        commenterId: root.getAttribute('data-user-id') || root.getAttribute('data-member-id') || commenterName || '',
        commenterName,
        commentText,
        commentRef,
        meta: {
          source: 'admin-comment',
          snippet: rootText.slice(0, 240),
        },
      });
    }

    return results.slice(0, maxItems);
  }, limit);
}

async function detectNewComments({ testMode = false } = {}) {
  const blogId = await resolveBlogId();
  if (!blogId) {
    throw new Error('blogId를 확인할 수 없습니다. bots/blog/config.json commenter.blogId 또는 published naver_url이 필요합니다.');
  }

  const config = getCommenterConfig();
  const adminUrl = `https://blog.naver.com/${blogId}/admin/comment`;
  return withBrowserPage(testMode, async (page) => {
    await goto(page, adminUrl);
    await page.waitForSelector('body');
    await humanDelay(2, 4, testMode);
    const extracted = await extractAdminComments(page, Math.min(config.maxDetectPerCycle, testMode ? 3 : config.maxDetectPerCycle));
    const inserted = [];
    for (const comment of extracted) {
      const saved = await saveDetectedComment(comment);
      if (saved.inserted) {
        inserted.push({ ...comment, id: saved.id });
      }
    }
    return inserted;
  });
}

async function getPostSummary(postUrl, { testMode = false } = {}) {
  return withBrowserPage(testMode, async (page) => {
    await goto(page, postUrl);
    await page.waitForSelector('body');
    await humanDelay(1, 2, testMode);
    const result = await page.evaluate((maxLen) => {
      function metaContent(selector) {
        const node = document.querySelector(selector);
        return String(node?.getAttribute?.('content') || '').replace(/\s+/g, ' ').trim();
      }
      function textOf(selector) {
        const node = document.querySelector(selector);
        return String(node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim();
      }

      const title = metaContent('meta[property="og:title"]') || textOf('title') || textOf('h3') || textOf('h1');
      const body = [
        '#post-view',
        '#postViewArea',
        '.se-main-container',
        '.post_ct',
        '.post-view',
        'body',
      ].map((selector) => textOf(selector)).find(Boolean) || '';

      return {
        title,
        summary: body.length > maxLen ? `${body.slice(0, maxLen - 1)}…` : body,
      };
    }, DEFAULT_SUMMARY_LEN);
    return {
      title: squeezeText(result?.title, 120),
      summary: squeezeText(result?.summary, DEFAULT_SUMMARY_LEN),
    };
  });
}

async function generateReply(postTitle, postSummary, commentText) {
  const messages = [
    {
      role: 'system',
      content: '너는 IT 블로그 운영자다. 네이버 블로그 댓글에 따뜻하고 자연스러운 한국어 답글을 JSON으로만 작성한다.',
    },
    {
      role: 'user',
      content: [
        `[글 제목] ${postTitle || ''}`,
        `[글 요약] ${postSummary || ''}`,
        `[댓글] ${commentText || ''}`,
        '',
        '규칙:',
        '- 50~200자',
        '- 댓글 내용에 맞는 구체적인 답변',
        '- 이모지 1~2개 자연스럽게 사용 가능',
        '- 질문형, 공감형, 정보형 중 하나',
        '- 기계적인 감사 인사만 반복 금지',
        '',
        'JSON만 응답: {"reply":"답글 내용","tone":"질문형|공감형|정보형"}',
      ].join('\n'),
    },
  ];

  const result = await callLocalLLMJSON(LOCAL_MODEL_FAST, messages, {
    temperature: 0.8,
    maxTokens: 300,
    timeoutMs: 20000,
  });

  return {
    reply: normalizeText(result?.reply || ''),
    tone: normalizeText(result?.tone || ''),
  };
}

function validateReply(reply, commentText, config = getCommenterConfig()) {
  const normalizedReply = normalizeText(reply);
  const normalizedComment = normalizeText(commentText);

  if (!normalizedReply || normalizedReply.length < config.minReplyLen) {
    return { ok: false, reason: 'too_short' };
  }
  if (normalizedReply.length > config.maxReplyLen) {
    return { ok: false, reason: 'too_long' };
  }
  if (normalizedComment && normalizedReply.includes(normalizedComment.slice(0, Math.min(20, normalizedComment.length)))) {
    return { ok: false, reason: 'copied_comment' };
  }

  const roboticPatterns = ['감사합니다 방문해', '좋은 하루 되세요', '공감하고 갑니다'];
  for (const pattern of roboticPatterns) {
    if (normalizedReply.includes(pattern)) {
      return { ok: false, reason: `robotic:${pattern}` };
    }
  }

  return { ok: true };
}

async function openReplyEditor(page, comment) {
  return page.evaluate(({ commentText, commenterName }) => {
    function textOf(el) {
      return String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    }
    function visible(el) {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }

    const selectors = ['li', 'div[class*="comment"]', 'article', 'section'];
    const candidates = [];
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        if (!visible(node)) continue;
        const text = textOf(node);
        if (!text) continue;
        let score = 0;
        if (commentText && text.includes(commentText.slice(0, Math.min(20, commentText.length)))) score += 3;
        if (commenterName && text.includes(commenterName)) score += 2;
        if (score > 0) candidates.push({ node, score });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    const target = candidates[0]?.node;
    if (!target) return false;

    const buttons = Array.from(target.querySelectorAll('button, a')).filter(visible);
    const replyButton = buttons.find((btn) => /답글|답변/.test(textOf(btn)));
    if (!replyButton) return false;
    replyButton.click();
    return true;
  }, {
    commentText: comment.comment_text,
    commenterName: comment.commenter_name,
  });
}

async function focusReplyEditor(page) {
  await page.waitForFunction(() => {
    const nodes = Array.from(document.querySelectorAll('textarea, div[contenteditable="true"], div[role="textbox"]'));
    return nodes.some((node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    });
  }, { timeout: 15000 });

  return page.evaluate(() => {
    function visible(el) {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }

    const nodes = Array.from(document.querySelectorAll('textarea, div[contenteditable="true"], div[role="textbox"]')).filter(visible);
    const target = nodes[nodes.length - 1];
    if (!target) return null;
    target.setAttribute('data-blog-commenter-editor', 'true');
    target.focus();
    return {
      selector: '[data-blog-commenter-editor="true"]',
      tagName: target.tagName.toLowerCase(),
      contentEditable: target.getAttribute('contenteditable') === 'true',
    };
  });
}

async function submitReply(page) {
  const clicked = await page.evaluate(() => {
    function textOf(el) {
      return String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    }
    function visible(el) {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }

    const buttons = Array.from(document.querySelectorAll('button, a')).filter(visible);
    const submit = buttons.find((btn) => /등록|답글|댓글 등록|확인/.test(textOf(btn)));
    if (!submit) return false;
    submit.click();
    return true;
  });

  if (!clicked) {
    throw new Error('reply_submit_not_found');
  }
}

async function typeReply(page, selector, replyText, config, testMode) {
  const durationMs = calcDelayMs(config.typingMinSec, config.typingMaxSec, testMode);
  const perCharDelay = Math.max(15, Math.min(180, Math.round(durationMs / Math.max(replyText.length, 1))));
  const target = await page.$(selector);
  if (!target) throw new Error('reply_editor_not_found');

  await target.click({ clickCount: 3 }).catch(() => {});
  await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control').catch(() => {});
  await page.keyboard.press('KeyA').catch(() => {});
  await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  await page.keyboard.type(replyText, { delay: perCharDelay });
}

async function postReply(comment, replyText, { testMode = false } = {}) {
  const config = getCommenterConfig();
  return withBrowserPage(testMode, async (page) => {
    await goto(page, comment.post_url);
    await page.waitForSelector('body');
    await humanDelay(config.pageReadMinSec, config.pageReadMaxSec, testMode);

    const opened = await openReplyEditor(page, comment);
    if (!opened) {
      throw new Error('reply_button_not_found');
    }

    await humanDelay(1, 2, testMode);
    const editor = await focusReplyEditor(page);
    if (!editor?.selector) {
      throw new Error('reply_editor_not_found');
    }

    await typeReply(page, editor.selector, replyText, config, testMode);
    await humanDelay(1, 2, testMode);
    await submitReply(page);
    await humanDelay(config.betweenCommentsMinSec, config.betweenCommentsMaxSec, testMode);
    return { ok: true };
  });
}

async function processComment(comment, options = {}) {
  const postInfo = await getPostSummary(comment.post_url, options);
  let generated = await generateReply(postInfo.title || comment.post_title, postInfo.summary, comment.comment_text);
  let validation = validateReply(generated.reply, comment.comment_text);

  if (!validation.ok) {
    generated = await generateReply(postInfo.title || comment.post_title, postInfo.summary, comment.comment_text);
    validation = validateReply(generated.reply, comment.comment_text);
  }

  if (!validation.ok) {
    await updateCommentStatus(comment.id, 'skipped', {
      errorMessage: validation.reason,
      meta: { phase: 'validate' },
    });
    return { ok: false, skipped: true, reason: validation.reason };
  }

  await postReply(comment, generated.reply, options);
  await updateCommentStatus(comment.id, 'replied', {
    replyText: generated.reply,
    meta: { tone: generated.tone || null },
  });
  await recordCommentAction('reply', {
    targetBlog: await resolveBlogId(),
    targetPostUrl: comment.post_url,
    commentText: generated.reply,
    success: true,
    meta: { commentId: comment.id, commenterName: comment.commenter_name || null },
  });
  return { ok: true, reply: generated.reply };
}

async function runCommentReply({ testMode = false } = {}) {
  const config = getCommenterConfig();
  if (!env.IS_OPS && !process.env.BLOG_COMMENTER_ALLOW_DEV) {
    return { skipped: true, reason: 'ops_only' };
  }
  if (!config.enabled && !testMode && process.env.BLOG_COMMENTER_FORCE !== 'true') {
    return { skipped: true, reason: 'disabled' };
  }
  if (!testMode && !isWithinActiveWindow(config)) {
    return { skipped: true, reason: 'inactive_window' };
  }

  await ensureSchema();

  const todayCount = await getTodayReplyCount();
  if (todayCount >= config.maxDaily) {
    return { skipped: true, reason: 'daily_limit', count: todayCount };
  }

  const newComments = await detectNewComments({ testMode });
  const pending = await getPendingComments(Math.min(config.maxProcessPerCycle, testMode ? 1 : config.maxProcessPerCycle));
  const remaining = Math.max(0, config.maxDaily - todayCount);
  const targets = pending.slice(0, testMode ? 1 : remaining);

  let replied = 0;
  let failed = 0;
  let skipped = 0;

  for (const comment of targets) {
    try {
      const result = await processComment(comment, { testMode });
      if (result.ok) replied += 1;
      else if (result.skipped) skipped += 1;
    } catch (error) {
      failed += 1;
      await updateCommentStatus(comment.id, 'failed', {
        errorMessage: error.message,
        meta: { phase: 'post' },
      });
      await recordCommentAction('reply', {
        targetBlog: await resolveBlogId(),
        targetPostUrl: comment.post_url,
        commentText: comment.comment_text,
        success: false,
        meta: { commentId: comment.id, error: error.message },
      }).catch(() => {});
    }
  }

  const totalProcessed = replied + failed + skipped;
  const failureRate = totalProcessed > 0 ? failed / totalProcessed : 0;
  if (replied > 0 || failed > 0) {
    await postAlarm({
      team: 'blog',
      fromBot: 'blog-commenter',
      alertLevel: failureRate >= 0.5 ? 3 : 2,
      message: `답댓글 ${replied}건 완료, 실패 ${failed}건, 스킵 ${skipped}건 (오늘 총 ${todayCount + replied}/${config.maxDaily})`,
    }).catch(() => {});
  }

  return {
    ok: true,
    detected: newComments.length,
    pending: pending.length,
    replied,
    failed,
    skipped,
    total: todayCount + replied,
    testMode,
  };
}

module.exports = {
  getCommenterConfig,
  resolveBlogId,
  ensureSchema,
  detectNewComments,
  generateReply,
  validateReply,
  getPostSummary,
  postReply,
  runCommentReply,
};
