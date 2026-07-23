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

type AnyRecord = Record<string, any>;
type QueryRows = AnyRecord[];
type CollectOptions = {
  json: boolean;
  dryRun: boolean;
  write: boolean;
  days: number;
  limit: number;
  postId: number | null;
  headful: boolean;
};
type NaverPost = {
  title: string;
  content: string;
  html: string;
  url: string;
};
type BlogPostRow = {
  id: number | string;
  title?: string;
  content?: string;
  html_content?: string;
  naver_url: string;
  previous_final_content_hash?: string;
  previous_final_title?: string;
};
type ContentDiff = {
  changed: boolean;
  originalContentHash: string;
  finalContentHash: string;
  diffSummary: string;
  metrics: AnyRecord;
  addedSamples: string[];
  removedSamples: string[];
};
type FinalContentResult = AnyRecord & {
  postId: number | string;
  naverUrl: string;
  status: string;
  changed: boolean | null;
  originalContentHash?: string | null;
  finalContentHash?: string | null;
  finalContentText?: string;
  _writePayload?: AnyRecord;
};
type PoolLike = {
  __rawQuery?: boolean;
  getPool?: () => unknown;
  query: (...args: any[]) => Promise<any>;
  run?: (...args: any[]) => Promise<any>;
};
type CollectDeps = {
  pgPool?: PoolLike;
  fetchFinalContent?: (naverUrl: string, options: Partial<CollectOptions>) => Promise<NaverPost>;
  recordFeedback?: (
    postId: number | string,
    originalTitle: string,
    finalTitle: string,
    originalHash: unknown,
    finalHash: unknown,
  ) => Promise<unknown>;
  addVaultEntry?: (entry: AnyRecord) => Promise<any>;
};
type BrowserLike = {
  newPage: () => Promise<PageLike>;
  close: () => Promise<void>;
  disconnect: () => Promise<void>;
};
type FrameLike = {
  evaluate: (fn: () => AnyRecord) => Promise<AnyRecord>;
};
type PageLike = FrameLike & {
  setDefaultNavigationTimeout: (ms: number) => void;
  setDefaultTimeout: (ms: number) => void;
  goto: (url: string, options: AnyRecord) => Promise<unknown>;
  frames: () => FrameLike[];
  mainFrame: () => FrameLike;
  close: () => Promise<void>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStack(error: unknown): string {
  return error instanceof Error && error.stack ? error.stack : String(error);
}

function parseArgs(argv: string[] = process.argv.slice(2)): CollectOptions {
  const options: CollectOptions = {
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

function parsePositiveInteger(value: unknown, fallback: number): number;
function parsePositiveInteger(value: unknown, fallback: null): number | null;
function parsePositiveInteger(value: unknown, fallback: number | null): number | null {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sha256(value: unknown): string {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function shortHash(value: unknown): string {
  return sha256(value).slice(0, 12);
}

function decodeHtmlEntities(value: unknown): string {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_: string, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_: string, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)));
}

function stripHtmlToText(html: unknown): string {
  return decodeHtmlEntities(String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/section|\/article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '));
}

function normalizeFinalContent(value: unknown): string {
  return String(value || '')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line: string) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function normalizeTitle(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function extractMetaContent(html: string, propertyName: string): string {
  const escaped = propertyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const propertyRegex = new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i');
  const nameRegex = new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i');
  const reversedRegex = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, 'i');
  const match = html.match(propertyRegex) || html.match(nameRegex) || html.match(reversedRegex);
  return match ? decodeHtmlEntities(match[1]) : '';
}

function extractTagText(html: unknown, tagName: string): string {
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

function hasPreferredBodyContainer(html: unknown): boolean {
  return PREFERRED_BODY_PATTERNS.some((pattern) => pattern.test(String(html || '')));
}

function extractPreferredBodyHtml(html: string): string {
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

function extractNaverPostFromHtml(html: unknown, fallback: Partial<NaverPost> = {}): NaverPost {
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

function extractNaverPostFromPayload(payload: AnyRecord | null | undefined): NaverPost {
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

function tokenizeForDiff(value: unknown): string[] {
  return normalizeFinalContent(value)
    .split(/[\s,.;:!?()[\]{}"'`~<>|/\\]+/g)
    .map((token: string) => token.trim())
    .filter((token: string) => token.length >= 2);
}

function uniqueSample(tokens: string[], limit = 8): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const token of tokens) {
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(token);
    if (output.length >= limit) break;
  }
  return output;
}

function computeContentDiff(originalContent: unknown, finalContent: unknown): ContentDiff {
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
  const originalSet = new Set(originalTokens.map((token: string) => token.toLowerCase()));
  const finalSet = new Set(finalTokens.map((token: string) => token.toLowerCase()));
  const added = finalTokens.filter((token: string) => !originalSet.has(token.toLowerCase()));
  const removed = originalTokens.filter((token: string) => !finalSet.has(token.toLowerCase()));
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

function buildOriginalContentFromPost(post: BlogPostRow): string {
  const content = normalizeFinalContent(post && post.content);
  if (content) return content;
  return normalizeFinalContent(stripHtmlToText(post && post.html_content));
}

function buildMasterEditVaultEntry({
  post,
  originalTitle,
  finalTitle,
  diff,
}: {
  post: BlogPostRow;
  originalTitle: string;
  finalTitle: string;
  diff: ContentDiff;
}): AnyRecord {
  const fileHash = shortHash(`${post.id}:${originalTitle}:${finalTitle}:${diff.originalContentHash}:${diff.finalContentHash}`);
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

async function withBrowser<T>(fn: (browser: BrowserLike) => Promise<T>, options: Partial<CollectOptions> = {}): Promise<T> {
  const puppeteer = require('puppeteer');
  const wsEndpoint = readNaverMonitorWsEndpoint();
  let browser: BrowserLike | null = null;
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
    return await fn(browser as BrowserLike);
  } finally {
    if (!browser) return undefined as T;
    if (owned) await browser.close();
    else await browser.disconnect();
  }
}

async function extractFromPage(page: PageLike): Promise<NaverPost> {
  const payload = await page.evaluate(() => {
    const meta = (name: string) => {
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

async function fetchNaverFinalContent(naverUrl: string, options: Partial<CollectOptions> = {}): Promise<NaverPost> {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getDefaultPgPool() {
  return require('../../../packages/core/lib/pg-pool');
}

function normalizeDbRows(result: AnyRecord[] | { rows?: AnyRecord[] } | null | undefined): QueryRows {
  if (Array.isArray(result)) return result;
  return result && Array.isArray(result.rows) ? result.rows : [];
}

async function poolQuery(pool: PoolLike, schema: string, sql: string, params: unknown[] = []): Promise<QueryRows> {
  if (pool && pool.__rawQuery) return normalizeDbRows(await pool.query(sql, params));
  if (pool && typeof pool.getPool === 'function' && typeof pool.query === 'function') {
    return normalizeDbRows(await pool.query(schema, sql, params));
  }
  return normalizeDbRows(await pool.query(sql, params));
}

async function poolRun(pool: PoolLike, schema: string, sql: string, params: unknown[] = []): Promise<any> {
  if (pool && pool.__rawQuery) return pool.query(sql, params);
  if (pool && typeof pool.run === 'function') return pool.run(schema, sql, params);
  if (pool && typeof pool.getPool === 'function' && typeof pool.query === 'function') return pool.query(schema, sql, params);
  return pool.query(sql, params);
}

async function tableExists(pool: PoolLike, qualifiedName: string): Promise<boolean> {
  const rows = await poolQuery(pool, 'public', 'SELECT to_regclass($1) AS regclass', [qualifiedName]);
  return Boolean(rows && rows[0] && rows[0].regclass);
}

async function tableHasColumns(pool: PoolLike, schemaName: string, tableName: string, columnNames: string[]): Promise<boolean> {
  const expected = Array.from(new Set(columnNames.filter(Boolean)));
  if (expected.length === 0) return true;
  const rows = await poolQuery(pool, 'public', `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = $1
      AND table_name = $2
      AND column_name = ANY($3::text[])
  `, [schemaName, tableName, expected]);
  const found = new Set((rows || []).map((row: AnyRecord) => row.column_name));
  return expected.every((columnName) => found.has(columnName));
}

async function selectFinalContentCandidates(pool: PoolLike, options: Partial<CollectOptions> = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit || DEFAULT_LIMIT), 100));
  const days = Math.max(1, Math.min(Number(options.days || DEFAULT_DAYS), 30));
  const ledgerExists = await tableExists(pool, 'blog.final_content_checks');
  const params: unknown[] = [];
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
    ? "AND (fcc.post_id IS NULL OR fcc.checked_at < NOW() - INTERVAL '24 hours')"
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
      ${ledgerExists ? ', fcc.final_content_hash AS previous_final_content_hash, fcc.final_title AS previous_final_title' : ''}
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

async function upsertFinalContentCheck(pool: PoolLike, row: FinalContentResult): Promise<void> {
  const metadata = JSON.stringify(row.metadata || {});
  await poolRun(pool, 'blog', `
    INSERT INTO blog.final_content_checks (
      post_id,
      naver_url,
      status,
      changed,
      original_content_hash,
      final_content_hash,
      final_title,
      final_content_text,
      diff_summary,
      vault_file_path,
      checked_at,
      metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), $11::jsonb)
    ON CONFLICT (post_id) DO UPDATE SET
      naver_url = EXCLUDED.naver_url,
      status = EXCLUDED.status,
      changed = EXCLUDED.changed,
      original_content_hash = EXCLUDED.original_content_hash,
      final_content_hash = EXCLUDED.final_content_hash,
      final_title = EXCLUDED.final_title,
      final_content_text = EXCLUDED.final_content_text,
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
    row.finalTitle || null,
    row.finalContentText || null,
    row.diffSummary || null,
    row.vaultFilePath || null,
    metadata
  ]);
}

async function addVaultEntry(entry: AnyRecord): Promise<any> {
  const modulePath = pathToFileURL(path.join(PROJECT_ROOT, 'bots/sigma/vault/vault-manager.ts')).href;
  const { VaultManager } = await import(modulePath);
  const vault = new VaultManager();
  return vault.addToInbox(entry);
}

async function recordMasterFeedback(postId: number | string, originalTitle: string, finalTitle: string, originalHash: unknown, finalHash: unknown) {
  const { recordFeedback } = require('../lib/feedback-learner.ts');
  return recordFeedback(postId, originalTitle, finalTitle, originalHash, finalHash);
}

async function processFinalContentCandidate(
  post: BlogPostRow,
  options: Partial<CollectOptions> = {},
  deps: CollectDeps = {},
): Promise<FinalContentResult> {
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
      metadata: { error: errorMessage(error) }
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
  const titleChanged = originalTitle !== finalTitle;
  const unchangedSinceLastCheck = Boolean(
    post.previous_final_content_hash
    && post.previous_final_content_hash === diff.finalContentHash
    && normalizeTitle(post.previous_final_title) === finalTitle
  );
  if (unchangedSinceLastCheck || (!diff.changed && !titleChanged)) {
    return {
      postId: post.id,
      naverUrl: post.naver_url,
      status: 'unchanged',
      changed: false,
      originalContentHash: diff.originalContentHash,
      finalContentHash: diff.finalContentHash,
      finalTitle,
      finalContentText: finalContent,
      diffSummary: unchangedSinceLastCheck ? 'no_new_final_change' : diff.diffSummary,
      vaultFilePath: null,
      metadata: { originalTitle, finalTitle, titleChanged, unchangedSinceLastCheck, metrics: diff.metrics }
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
    finalTitle,
    finalContentText: finalContent,
    diffSummary: titleChanged && !diff.changed
      ? `title_changed: ${originalTitle} -> ${finalTitle}`
      : diff.diffSummary,
    vaultFilePath: vaultEntry.filePath,
    metadata: {
      originalTitle,
      finalTitle,
      titleChanged,
      finalContentLength: finalContent.length,
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

async function ensureWriteTables(pool: PoolLike) {
  const masterFeedbackExists = await tableExists(pool, 'blog.master_feedback');
  const finalChecksExists = await tableExists(pool, 'blog.final_content_checks');
  const finalContentColumnsReady = finalChecksExists
    ? await tableHasColumns(pool, 'blog', 'final_content_checks', ['final_title', 'final_content_text'])
    : false;
  return {
    ok: masterFeedbackExists && finalChecksExists && finalContentColumnsReady,
    masterFeedbackExists,
    finalChecksExists,
    finalContentColumnsReady
  };
}

async function persistFinalContentResult(pool: PoolLike, result: FinalContentResult, deps: CollectDeps = {}): Promise<FinalContentResult> {
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
          vaultError: errorMessage(error)
        };
      }
    }
  }
  await upsertFinalContentCheck(pool, writableResult);
  return writableResult;
}

function publicResult(result: FinalContentResult): AnyRecord {
  const { _writePayload, finalContentText, ...rest } = result;
  if (finalContentText) rest.finalContentLength = finalContentText.length;
  return rest;
}

async function runCollectFinalContent(options: Partial<CollectOptions> = {}, deps: CollectDeps = {}): Promise<AnyRecord> {
  const effectiveOptions = {
    ...parseArgs([]),
    ...options
  };
  const dryRun = effectiveOptions.write !== true;
  const pool = deps.pgPool || await getDefaultPgPool();
  const warnings: string[] = [];

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

  const results: AnyRecord[] = [];
  for (const post of selection.rows as BlogPostRow[]) {
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
      error: errorStack(error)
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
    tableHasColumns,
    ensureWriteTables,
    persistFinalContentResult
  }
};
