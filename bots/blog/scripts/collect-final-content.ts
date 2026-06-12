#!/usr/bin/env tsx

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const DEFAULT_DAYS = 3;
const DEFAULT_LIMIT = 20;
const NAV_TIMEOUT_MS = 45_000;
const BLOG_BROWSER_RUNTIME_DIR = path.join(os.homedir(), '.ai-agent-blog-browser');
const NAVER_MONITOR_WS_FILES = [
  path.join(BLOG_BROWSER_RUNTIME_DIR, 'naver-monitor-ws-endpoint.txt'),
  path.join(PROJECT_ROOT, 'output/blog/naver-monitor-ws-endpoint.txt')
];
const DEFAULT_NAVER_PROFILE_DIR = path.join(os.homedir(), 'Library/Application Support/Google/Chrome');

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    json: false,
    dryRun: true,
    write: false,
    days: DEFAULT_DAYS,
    limit: DEFAULT_LIMIT,
    postId: null,
    headful: false
  };

  for (const arg of argv) {
    if (arg === '--json') options.json = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--write') {
      options.write = true;
      options.dryRun = false;
    } else if (arg === '--headful') options.headful = true;
    else if (arg.startsWith('--days=')) options.days = parsePositiveInteger(arg.slice('--days='.length), DEFAULT_DAYS);
    else if (arg.startsWith('--limit=')) options.limit = parsePositiveInteger(arg.slice('--limit='.length), DEFAULT_LIMIT);
    else if (arg.startsWith('--post-id=')) options.postId = parsePositiveInteger(arg.slice('--post-id='.length), null);
  }

  return options;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function shortHash(value) {
  return sha256(value).slice(0, 12);
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)));
}

function stripHtmlToText(html) {
  return decodeHtmlEntities(String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/section|\/article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '));
}

function normalizeFinalContent(value) {
  return String(value || '')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function normalizeTitle(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function extractMetaContent(html, propertyName) {
  const escaped = propertyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const propertyRegex = new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i');
  const nameRegex = new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i');
  const reversedRegex = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, 'i');
  const match = html.match(propertyRegex) || html.match(nameRegex) || html.match(reversedRegex);
  return match ? decodeHtmlEntities(match[1]) : '';
}

function extractTagText(html, tagName) {
  const regex = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = String(html || '').match(regex);
  return match ? stripHtmlToText(match[1]) : '';
}

const PREFERRED_BODY_PATTERNS = [
  /<div[^>]+id=["']postViewArea["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/i,
  /<div[^>]+id=["']postViewArea["'][^>]*>([\s\S]*?)<\/div>/i,
  /<div[^>]+id=["']post-view[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/i,
  /<div[^>]+id=["']post-view[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  /<div[^>]+class=["'][^"']*se-main-container[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i,
  /<div[^>]+class=["'][^"']*se-main-container[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  /<article\b[^>]*>([\s\S]*?)<\/article>/i
];

function hasPreferredBodyContainer(html) {
  return PREFERRED_BODY_PATTERNS.some((pattern) => pattern.test(String(html || '')));
}

function extractPreferredBodyHtml(html) {
  const patterns = [
    ...PREFERRED_BODY_PATTERNS,
    /<body\b[^>]*>([\s\S]*?)<\/body>/i
  ];
  for (const pattern of patterns) {
    const match = String(html || '').match(pattern);
    if (match && match[1]) return match[1];
  }
  return html;
}

function extractNaverPostFromHtml(html, fallback = {}) {
  const source = String(html || '');
  const title = normalizeTitle(
    extractMetaContent(source, 'og:title')
      || extractMetaContent(source, 'twitter:title')
      || extractTagText(source, 'title')
      || fallback.title
  );
  const bodyHtml = extractPreferredBodyHtml(source);
  const content = normalizeFinalContent(stripHtmlToText(bodyHtml));
  return {
    title,
    content,
    html: source,
    url: fallback.url || ''
  };
}

function extractNaverPostFromPayload(payload) {
  const html = payload && payload.html ? String(payload.html) : '';
  if (html && hasPreferredBodyContainer(html)) {
    const post = extractNaverPostFromHtml(html, {
      title: (payload && payload.ogTitle) || (payload && payload.title),
      url: payload && payload.url
    });
    if ((post.content || '').length >= 20) return post;
  }

  const bodyText = normalizeFinalContent(payload && payload.text);
  if (bodyText.length >= 80) {
    return {
      title: normalizeTitle((payload && payload.ogTitle) || (payload && payload.title)),
      content: bodyText,
      html: payload && payload.html ? String(payload.html) : '',
      url: payload && payload.url ? String(payload.url) : ''
    };
  }
  return extractNaverPostFromHtml(html, {
    title: payload && payload.title,
    url: payload && payload.url
  });
}

function tokenizeForDiff(value) {
  return normalizeFinalContent(value)
    .split(/[\s,.;:!?()[\]{}"'`~<>|/\\]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function uniqueSample(tokens, limit = 8) {
  const seen = new Set();
  const output = [];
  for (const token of tokens) {
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(token);
    if (output.length >= limit) break;
  }
  return output;
}

function computeContentDiff(originalContent, finalContent) {
  const original = normalizeFinalContent(originalContent);
  const final = normalizeFinalContent(finalContent);
  const originalHash = sha256(original);
  const finalHash = sha256(final);
  const changed = originalHash !== finalHash;
  if (!changed) {
    return {
      changed: false,
      originalContentHash: originalHash,
      finalContentHash: finalHash,
      diffSummary: 'no_change',
      metrics: {
        originalLength: original.length,
        finalLength: final.length,
        addedTokenCount: 0,
        removedTokenCount: 0,
        changeRate: 0
      },
      addedSamples: [],
      removedSamples: []
    };
  }

  const originalTokens = tokenizeForDiff(original);
  const finalTokens = tokenizeForDiff(final);
  const originalSet = new Set(originalTokens.map((token) => token.toLowerCase()));
  const finalSet = new Set(finalTokens.map((token) => token.toLowerCase()));
  const added = finalTokens.filter((token) => !originalSet.has(token.toLowerCase()));
  const removed = originalTokens.filter((token) => !finalSet.has(token.toLowerCase()));
  const addedSamples = uniqueSample(added);
  const removedSamples = uniqueSample(removed);
  const denominator = Math.max(originalTokens.length, 1);
  const changeRate = Number(((added.length + removed.length) / denominator).toFixed(4));
  const diffSummary = [
    `본문 변경 감지: +${added.length}/-${removed.length} 토큰, 길이 변화 ${final.length - original.length}자.`,
    addedSamples.length ? `추가: ${addedSamples.join(', ')}` : '',
    removedSamples.length ? `삭제: ${removedSamples.join(', ')}` : ''
  ].filter(Boolean).join(' ');

  return {
    changed: true,
    originalContentHash: originalHash,
    finalContentHash: finalHash,
    diffSummary,
    metrics: {
      originalLength: original.length,
      finalLength: final.length,
      addedTokenCount: added.length,
      removedTokenCount: removed.length,
      changeRate
    },
    addedSamples,
    removedSamples
  };
}

function buildOriginalContentFromPost(post) {
  const content = normalizeFinalContent(post && post.content);
  if (content) return content;
  return normalizeFinalContent(stripHtmlToText(post && post.html_content));
}

function buildMasterEditVaultEntry({ post, originalTitle, finalTitle, diff }) {
  const fileHash = shortHash(`${post.id}:${diff.originalContentHash}:${diff.finalContentHash}`);
  const filePath = `library/blo/master_edit/${post.id}-${fileHash}`;
  const content = [
    `# Master edit diff: ${finalTitle || originalTitle || `post ${post.id}`}`,
    '',
    `post_id: ${post.id}`,
    `naver_url: ${post.naver_url}`,
    `original_title: ${originalTitle || ''}`,
    `final_title: ${finalTitle || ''}`,
    `original_hash: ${diff.originalContentHash}`,
    `final_hash: ${diff.finalContentHash}`,
    '',
    diff.diffSummary,
    '',
    diff.addedSamples.length ? `added_samples: ${diff.addedSamples.join(', ')}` : '',
    diff.removedSamples.length ? `removed_samples: ${diff.removedSamples.join(', ')}` : ''
  ].filter((line) => line !== '').join('\n');

  return {
    source: 'blo',
    type: 'master_edit',
    title: `Blog master edit ${post.id}`,
    content,
    filePath,
    tags: ['blo', 'master_edit', `post_${post.id}`],
    meta: {
      postId: post.id,
      naverUrl: post.naver_url,
      originalTitle,
      finalTitle,
      originalContentHash: diff.originalContentHash,
      finalContentHash: diff.finalContentHash,
      diffSummary: diff.diffSummary,
      metrics: diff.metrics
    }
  };
}

function readNaverMonitorWsEndpoint() {
  for (const file of NAVER_MONITOR_WS_FILES) {
    try {
      if (!fs.existsSync(file)) continue;
      const endpoint = fs.readFileSync(file, 'utf8').trim();
      if (endpoint) return endpoint;
    } catch (_) {
      // Ignore stale endpoint files.
    }
  }
  return process.env.BLOG_NAVER_BROWSER_WS_ENDPOINT || process.env.NAVER_BROWSER_WS_ENDPOINT || null;
}

async function withBrowser(fn, options = {}) {
  const puppeteer = require('puppeteer');
  const wsEndpoint = readNaverMonitorWsEndpoint();
  let browser = null;
  let owned = false;

  if (wsEndpoint) {
    try {
      browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
    } catch (error) {
      browser = null;
    }
  }

  if (!browser) {
    owned = true;
    browser = await puppeteer.launch({
      headless: options.headful ? false : 'new',
      userDataDir: process.env.BLOG_NAVER_PROFILE_DIR || DEFAULT_NAVER_PROFILE_DIR,
      defaultViewport: { width: 1365, height: 1600 },
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  }

  try {
    return await fn(browser);
  } finally {
    if (!browser) return;
    if (owned) await browser.close();
    else await browser.disconnect();
  }
}

async function extractFromPage(page) {
  const payload = await page.evaluate(() => {
    const meta = (name) => {
      const selector = `meta[property="${name}"], meta[name="${name}"]`;
      const el = document.querySelector(selector);
      return el ? el.getAttribute('content') || '' : '';
    };
    return {
      url: location.href,
      title: document.title || '',
      ogTitle: meta('og:title'),
      text: document.body ? document.body.innerText || '' : '',
      html: document.documentElement ? document.documentElement.outerHTML || '' : ''
    };
  });
  return extractNaverPostFromPayload(payload);
}

async function fetchNaverFinalContent(naverUrl, options = {}) {
  return withBrowser(async (browser) => {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    page.setDefaultTimeout(NAV_TIMEOUT_MS);
    try {
      await page.goto(naverUrl, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });
      await sleep(1200);
      let best = await extractFromPage(page);
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        try {
          const payload = await frame.evaluate(() => ({
            url: location.href,
            title: document.title || '',
            ogTitle: '',
            text: document.body ? document.body.innerText || '' : '',
            html: document.documentElement ? document.documentElement.outerHTML || '' : ''
          }));
          const candidate = extractNaverPostFromPayload(payload);
          if ((candidate.content || '').length > (best.content || '').length) best = candidate;
        } catch (_) {
          // Ignore inaccessible cross-origin frames.
        }
      }
      return best;
    } finally {
      await page.close();
    }
  }, options);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getDefaultPgPool() {
  return require('../../../packages/core/lib/pg-pool');
}

function normalizeDbRows(result) {
  if (Array.isArray(result)) return result;
  return result && Array.isArray(result.rows) ? result.rows : [];
}

async function poolQuery(pool, schema, sql, params = []) {
  if (pool && pool.__rawQuery) return normalizeDbRows(await pool.query(sql, params));
  if (pool && typeof pool.getPool === 'function' && typeof pool.query === 'function') {
    return normalizeDbRows(await pool.query(schema, sql, params));
  }
  return normalizeDbRows(await pool.query(sql, params));
}

async function poolRun(pool, schema, sql, params = []) {
  if (pool && pool.__rawQuery) return pool.query(sql, params);
  if (pool && typeof pool.run === 'function') return pool.run(schema, sql, params);
  if (pool && typeof pool.getPool === 'function' && typeof pool.query === 'function') return pool.query(schema, sql, params);
  return pool.query(sql, params);
}

async function tableExists(pool, qualifiedName) {
  const rows = await poolQuery(pool, 'public', 'SELECT to_regclass($1) AS regclass', [qualifiedName]);
  return Boolean(rows && rows[0] && rows[0].regclass);
}

async function selectFinalContentCandidates(pool, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit || DEFAULT_LIMIT), 100));
  const days = Math.max(1, Math.min(Number(options.days || DEFAULT_DAYS), 30));
  const ledgerExists = await tableExists(pool, 'blog.final_content_checks');
  const params = [];
  let whereDate = '';
  if (options.postId) {
    params.push(options.postId);
    whereDate = `AND p.id = $${params.length}`;
  } else {
    params.push(`${days} days`);
    whereDate = `
      AND COALESCE(p.publish_date::timestamptz, p.created_at) >= NOW() - $${params.length}::interval
      AND COALESCE(p.publish_date::timestamptz, p.created_at) < CURRENT_DATE
    `;
  }
  params.push(limit);

  const ledgerJoin = ledgerExists
    ? 'LEFT JOIN blog.final_content_checks fcc ON fcc.post_id = p.id'
    : '';
  const ledgerFilter = ledgerExists
    ? 'AND fcc.post_id IS NULL'
    : '';

  const sql = `
    SELECT
      p.id,
      p.title,
      p.content,
      p.html_content,
      p.naver_url,
      p.publish_date,
      p.created_at
    FROM blog.posts p
    ${ledgerJoin}
    WHERE p.status = 'published'
      AND COALESCE(p.naver_url, '') <> ''
      ${whereDate}
      ${ledgerFilter}
    ORDER BY COALESCE(p.publish_date::timestamptz, p.created_at) DESC, p.id DESC
    LIMIT $${params.length}
  `;
  const rows = await poolQuery(pool, 'blog', sql, params);
  return {
    ledgerExists,
    rows: rows || []
  };
}

async function upsertFinalContentCheck(pool, row) {
  const metadata = JSON.stringify(row.metadata || {});
  await poolRun(pool, 'blog', `
    INSERT INTO blog.final_content_checks (
      post_id,
      naver_url,
      status,
      changed,
      original_content_hash,
      final_content_hash,
      diff_summary,
      vault_file_path,
      checked_at,
      metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9::jsonb)
    ON CONFLICT (post_id) DO UPDATE SET
      naver_url = EXCLUDED.naver_url,
      status = EXCLUDED.status,
      changed = EXCLUDED.changed,
      original_content_hash = EXCLUDED.original_content_hash,
      final_content_hash = EXCLUDED.final_content_hash,
      diff_summary = EXCLUDED.diff_summary,
      vault_file_path = EXCLUDED.vault_file_path,
      checked_at = EXCLUDED.checked_at,
      metadata = EXCLUDED.metadata
  `, [
    row.postId,
    row.naverUrl,
    row.status,
    row.changed,
    row.originalContentHash || null,
    row.finalContentHash || null,
    row.diffSummary || null,
    row.vaultFilePath || null,
    metadata
  ]);
}

async function addVaultEntry(entry) {
  const modulePath = pathToFileURL(path.join(PROJECT_ROOT, 'bots/sigma/vault/vault-manager.ts')).href;
  const { VaultManager } = await import(modulePath);
  const vault = new VaultManager();
  return vault.addToInbox(entry);
}

async function recordMasterFeedback(postId, originalTitle, finalTitle, originalHash, finalHash) {
  const { recordFeedback } = require('../lib/feedback-learner.ts');
  return recordFeedback(postId, originalTitle, finalTitle, originalHash, finalHash);
}

async function processFinalContentCandidate(post, options = {}, deps = {}) {
  const originalContent = buildOriginalContentFromPost(post);
  const originalTitle = normalizeTitle(post.title);
  if (!originalContent) {
    return {
      postId: post.id,
      naverUrl: post.naver_url,
      status: 'skipped_empty_original',
      changed: false,
      originalContentHash: null,
      finalContentHash: null,
      diffSummary: 'original_content_empty',
      vaultFilePath: null,
      metadata: { reason: 'original_content_empty' }
    };
  }

  let finalPost;
  try {
    const fetcher = deps.fetchFinalContent || fetchNaverFinalContent;
    finalPost = await fetcher(post.naver_url, { headful: options.headful });
  } catch (error) {
    return {
      postId: post.id,
      naverUrl: post.naver_url,
      status: 'fetch_failed',
      changed: null,
      originalContentHash: sha256(originalContent),
      finalContentHash: null,
      diffSummary: 'fetch_failed',
      vaultFilePath: null,
      metadata: { error: error && error.message ? error.message : String(error) }
    };
  }

  const finalContent = normalizeFinalContent(finalPost && finalPost.content);
  if (!finalContent) {
    return {
      postId: post.id,
      naverUrl: post.naver_url,
      status: 'fetch_failed',
      changed: null,
      originalContentHash: sha256(originalContent),
      finalContentHash: null,
      diffSummary: 'final_content_empty',
      vaultFilePath: null,
      metadata: { reason: 'final_content_empty', finalTitle: normalizeTitle(finalPost && finalPost.title) }
    };
  }

  const finalTitle = normalizeTitle(finalPost && finalPost.title) || originalTitle;
  const diff = computeContentDiff(originalContent, finalContent);
  if (!diff.changed) {
    return {
      postId: post.id,
      naverUrl: post.naver_url,
      status: 'unchanged',
      changed: false,
      originalContentHash: diff.originalContentHash,
      finalContentHash: diff.finalContentHash,
      diffSummary: diff.diffSummary,
      vaultFilePath: null,
      metadata: { originalTitle, finalTitle, metrics: diff.metrics }
    };
  }

  const vaultEntry = buildMasterEditVaultEntry({ post, originalTitle, finalTitle, diff });
  return {
    postId: post.id,
    naverUrl: post.naver_url,
    status: 'changed',
    changed: true,
    originalContentHash: diff.originalContentHash,
    finalContentHash: diff.finalContentHash,
    diffSummary: diff.diffSummary,
    vaultFilePath: vaultEntry.filePath,
    metadata: {
      originalTitle,
      finalTitle,
      metrics: diff.metrics,
      addedSamples: diff.addedSamples,
      removedSamples: diff.removedSamples
    },
    _writePayload: {
      originalTitle,
      finalTitle,
      vaultEntry
    }
  };
}

async function ensureWriteTables(pool) {
  const masterFeedbackExists = await tableExists(pool, 'blog.master_feedback');
  const finalChecksExists = await tableExists(pool, 'blog.final_content_checks');
  return {
    ok: masterFeedbackExists && finalChecksExists,
    masterFeedbackExists,
    finalChecksExists
  };
}

async function persistFinalContentResult(pool, result, deps = {}) {
  const writableResult = { ...result };
  if (result.changed && result._writePayload) {
    const record = deps.recordFeedback || recordMasterFeedback;
    const feedback = await record(
      result.postId,
      result._writePayload.originalTitle,
      result._writePayload.finalTitle,
      result.originalContentHash,
      result.finalContentHash
    );
    if (!feedback) {
      writableResult.status = 'feedback_failed';
      writableResult.metadata = {
        ...writableResult.metadata,
        feedbackRecorded: false
      };
    } else {
      const addEntry = deps.addVaultEntry || addVaultEntry;
      try {
        const vaultResult = await addEntry(result._writePayload.vaultEntry);
        writableResult.metadata = {
          ...writableResult.metadata,
          feedbackRecorded: true,
          vaultStored: true,
          vaultResult
        };
      } catch (error) {
        writableResult.status = 'vault_failed';
        writableResult.metadata = {
          ...writableResult.metadata,
          feedbackRecorded: true,
          vaultStored: false,
          vaultError: error && error.message ? error.message : String(error)
        };
      }
    }
  }
  await upsertFinalContentCheck(pool, writableResult);
  return writableResult;
}

function publicResult(result) {
  const { _writePayload, ...rest } = result;
  return rest;
}

async function runCollectFinalContent(options = {}, deps = {}) {
  const effectiveOptions = {
    ...parseArgs([]),
    ...options
  };
  const dryRun = effectiveOptions.write !== true;
  const pool = deps.pgPool || await getDefaultPgPool();
  const warnings = [];

  const selection = await selectFinalContentCandidates(pool, effectiveOptions);
  if (!selection.ledgerExists) warnings.push('final_content_checks_missing');

  let writeTables = null;
  if (!dryRun) {
    writeTables = await ensureWriteTables(pool);
    if (!writeTables.ok) {
      return {
        ok: false,
        dryRun,
        writeEnabled: true,
        reason: 'missing_required_tables',
        writeTables,
        candidates: selection.rows.length,
        warnings,
        results: []
      };
    }
  }

  const results = [];
  for (const post of selection.rows) {
    const processed = await processFinalContentCandidate(post, effectiveOptions, deps);
    const persisted = dryRun ? processed : await persistFinalContentResult(pool, processed, deps);
    results.push(publicResult(persisted));
  }

  const summary = {
    ok: results.every((result) => !['feedback_failed', 'vault_failed'].includes(result.status)),
    dryRun,
    writeEnabled: !dryRun,
    candidates: selection.rows.length,
    processed: results.length,
    changed: results.filter((result) => result.changed === true).length,
    unchanged: results.filter((result) => result.status === 'unchanged').length,
    failed: results.filter((result) => String(result.status || '').endsWith('_failed')).length,
    warnings,
    results
  };
  return summary;
}

async function main() {
  const options = parseArgs();
  try {
    const report = await runCollectFinalContent(options);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`final-content-diff dryRun=${report.dryRun} candidates=${report.candidates} changed=${report.changed} failed=${report.failed}`);
    }
    process.exit(report.ok ? 0 : 1);
  } catch (error) {
    const report = {
      ok: false,
      error: error && error.stack ? error.stack : String(error)
    };
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else console.error(report.error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  normalizeFinalContent,
  stripHtmlToText,
  extractNaverPostFromHtml,
  computeContentDiff,
  buildMasterEditVaultEntry,
  buildOriginalContentFromPost,
  selectFinalContentCandidates,
  processFinalContentCandidate,
  upsertFinalContentCheck,
  runCollectFinalContent,
  _testOnly: {
    decodeHtmlEntities,
    extractNaverPostFromPayload,
    tableExists,
    ensureWriteTables,
    persistFinalContentResult
  }
};
