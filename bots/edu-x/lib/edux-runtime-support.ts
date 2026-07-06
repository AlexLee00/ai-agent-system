// @ts-nocheck
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const kst = require('../../../packages/core/lib/kst');
const {
  sanitizePublicPostContent,
  ensurePublicMarketBriefDisclaimer,
  hasPublicMarketBriefDisclaimer,
  detectPublicPostContentLeaks,
} = require('./edux-content-safety.ts');

const OUTPUT_DIR = path.join(env.PROJECT_ROOT, 'bots', 'edu-x', 'output');
const DRY_RUN_DIR = path.join(OUTPUT_DIR, 'dry-run');
const PROMOTION_GATE_REPORT = path.join(OUTPUT_DIR, 'edux-promotion-gate.json');
const INTEGRATION_REPORT = path.join(OUTPUT_DIR, 'edux-integration-report.json');
const MIN_CONTENT_LEN = 0;
const MIN_IMAGES_PER_POST = 0;
const SECTION_BLOCK_SPACER_HTML = '<p>&nbsp;</p>';
const LEGACY_SECTION_MARKERS_RE = /^[①②③④⑤⑥⑦⑧⑨⑩]\s*/;
const SECTION_HEADING_EMOJI_RE = /^(?:[①②③④⑤⑥⑦⑧⑨⑩]\s*)?(?:(?:🧭|⚡|₿|📌|🌐|📰|📈|🛡️?|💸|💎|👀|🗓️?|🤖|⚠️?)\s+|■\s*)/u;
const REQUIRED_SECTION_COUNT = 10;
const REQUIRED_SECTIONS_BY_CATEGORY = {
  crypto: [
    { key: 'quick_read', prefix: '⚡', keywords: ['핵심', '3줄', '요약'] },
    { key: 'price_map', prefix: '📌', keywords: ['btc/usdt', '가격', '지도'] },
    { key: 'scenarios', prefix: '📈', keywords: ['상승', '하락', '시나리오'] },
    { key: 'community_news', prefix: '🌐', keywords: ['커뮤니티', '뉴스', '이슈'] },
    { key: 'ai_recommendation', prefix: '🤖', keywords: ['인공지능', '추천'] },
    { key: 'checkpoint_disclaimer', prefix: '⚠', keywords: ['체크포인트', '면책'] },
  ],
  kis: [
    { key: 'quick_read', prefix: '⚡', keywords: ['핵심', '3줄', '요약'] },
    { key: 'market_flow_map', prefix: '📌', keywords: ['지수', '수급', '지도'] },
    { key: 'sector_watch', prefix: '👀', keywords: ['섹터', '워치'] },
    { key: 'community_news', prefix: '🌐', keywords: ['커뮤니티', '뉴스', '이슈'] },
    { key: 'ai_recommendation', prefix: '🤖', keywords: ['인공지능', '추천'] },
    { key: 'checkpoint_disclaimer', prefix: '⚠', keywords: ['체크포인트', '면책'] },
  ],
  overseas: [
    { key: 'quick_read', prefix: '⚡', keywords: ['핵심', '3줄', '요약'] },
    { key: 'market_risk_map', prefix: '📌', keywords: ['지수', '리스크', '지도'] },
    { key: 'mag7_sector_map', prefix: '💎', keywords: ['magnificent', '7', '섹터', '지도'] },
    { key: 'community_news', prefix: '🌐', keywords: ['커뮤니티', '뉴스', '이슈'] },
    { key: 'ai_recommendation', prefix: '🤖', keywords: ['인공지능', '추천'] },
    { key: 'checkpoint_disclaimer', prefix: '⚠', keywords: ['체크포인트', '면책'] },
  ],
  kis_close: [
    { key: 'close_index', prefix: '■', keywords: ['마감', '확정치'] },
    { key: 'flow_close', prefix: '■', keywords: ['수급', '확정'] },
    { key: 'sector_winners_losers', prefix: '■', keywords: ['섹터', '승자', '패자'] },
    { key: 'plan_vs_actual', prefix: '■', keywords: ['09:00', '예고', '실제'] },
    { key: 'why_it_matters', prefix: '■', keywords: ['핵심', '이슈'] },
    { key: 'tomorrow_watch', prefix: '■', keywords: ['내일', '관찰'] },
  ],
  overseas_close: [
    { key: 'close_index', prefix: '■', keywords: ['3대', '지수', '종가'] },
    { key: 'mag7_close', prefix: '■', keywords: ['Mag7'] },
    { key: 'macro_sector_close', prefix: '■', keywords: ['섹터', '금리', '달러'] },
    { key: 'headline_review', prefix: '■', keywords: ['헤드라인', '회고'] },
    { key: 'korea_implications', prefix: '■', keywords: ['한국', '시사점'] },
    { key: 'korea_watch', prefix: '■', keywords: ['한국장', '관찰'] },
  ],
};
const CRYPTO_PLACEHOLDER_RE = /수집 대기|데이터 없음|데이터 부족|충분히 수집되지|N\/A|다음 슬롯에서 재확인|차트에서 재확인|미확인/i;

function isSectionHeadingLine(line) {
  return SECTION_HEADING_EMOJI_RE.test(String(line || '').trim());
}

function normalizeSectionHeadingLine(line) {
  const text = String(line || '').trim();
  return isSectionHeadingLine(text) ? text.replace(LEGACY_SECTION_MARKERS_RE, '') : text;
}

function extractSectionHeadings(content) {
  return String(content || '')
    .split(/\r?\n/)
    .map((line) => normalizeSectionHeadingLine(line))
    .filter((line) => isSectionHeadingLine(line));
}

function normalizeHeadingForMatch(heading) {
  return String(heading || '')
    .replace(/\uFE0F/g, '')
    .trim()
    .toLowerCase();
}

function headingMatchesRule(heading, rule) {
  const text = normalizeHeadingForMatch(heading);
  const prefix = normalizeHeadingForMatch(rule.prefix);
  if (!text.startsWith(prefix)) return false;
  return (rule.keywords || []).some((keyword) => text.includes(String(keyword).toLowerCase()));
}

function sectionContractKey(category, slot = null) {
  if (category === 'kis' && String(slot || '') === '1600') return 'kis_close';
  if (category === 'overseas' && String(slot || '') === '0630') return 'overseas_close';
  return category;
}

function resolveSectionValidation(content, category, slot = null) {
  const headings = extractSectionHeadings(content);
  const contractKey = sectionContractKey(category, slot);
  const categoryKeys = contractKey && REQUIRED_SECTIONS_BY_CATEGORY[contractKey]
    ? [contractKey]
    : Object.keys(REQUIRED_SECTIONS_BY_CATEGORY);
  const candidates = categoryKeys.map((key) => {
    const rules = REQUIRED_SECTIONS_BY_CATEGORY[key];
    const missingSections = rules
      .filter((rule) => !headings.some((heading) => headingMatchesRule(heading, rule)))
      .map((rule) => rule.key);
    return { category: key, headings, missingSections };
  });
  return candidates.sort((a, b) => a.missingSections.length - b.missingSections.length)[0];
}

function requiredSectionCountFor(category, slot = null) {
  const contractKey = sectionContractKey(category, slot);
  return REQUIRED_SECTIONS_BY_CATEGORY[contractKey]?.length || REQUIRED_SECTION_COUNT;
}

function validateCryptoInformationDensity(text) {
  const issues = [];
  if (CRYPTO_PLACEHOLDER_RE.test(text)) issues.push('crypto_placeholder_text');
  const numericSignalCount = (String(text).match(/\$[\d,.]+[KMBT]?|\b\d+(?:\.\d+)?K\b|\b\d+(?:\.\d+)?%|\b\d+(?:\.\d+)?점/g) || []).length;
  if (numericSignalCount < 8) issues.push(`crypto_numeric_signals:${numericSignalCount}/8`);
  const requiredTerms = [
    { key: 'current_price', re: /현재가|가격/ },
    { key: 'support', re: /지지/ },
    { key: 'resistance', re: /저항/ },
    { key: 'bull_scenario', re: /상승 시나리오/ },
    { key: 'bear_scenario', re: /하락 시나리오/ },
    { key: 'invalidation', re: /무효화|이탈|돌파 실패/ },
    { key: 'community_issue', re: /커뮤니티|뉴스|이슈/ },
  ];
  for (const item of requiredTerms) {
    if (!item.re.test(text)) issues.push(`crypto_missing_${item.key}`);
  }
  return issues;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    dryRunFlag: false,
    json: false,
    fixture: false,
    noWrite: false,
    oneOffLiveTest: false,
    testPost: false,
    excludeFromLunaEvidence: false,
    slot: null,
    category: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === '--dry-run') args.dryRunFlag = true;
    else if (item === '--json') args.json = true;
    else if (item === '--fixture') args.fixture = true;
    else if (item === '--no-write') args.noWrite = true;
    else if (item === '--one-off-live-test') args.oneOffLiveTest = true;
    else if (item === '--test-post') args.testPost = true;
    else if (item === '--exclude-from-luna-evidence') args.excludeFromLunaEvidence = true;
    else if (item === '--slot' && argv[i + 1]) args.slot = argv[++i];
    else if (item.startsWith('--slot=')) args.slot = item.split('=', 2)[1];
    else if (item === '--category' && argv[i + 1]) args.category = argv[++i];
    else if (item.startsWith('--category=')) args.category = item.split('=', 2)[1];
  }
  return args;
}

function resolvePublishLogSafetyMetadata(record = {}) {
  const metadata = record.metadata || {};
  const liveGate = metadata.liveGate || {};
  const title = String(record.title || '').trim();
  const testPost = record.testPost === true
    || metadata.testPost === true
    || metadata.oneOffLiveTest === true
    || liveGate.mode === 'one_off_live_test'
    || /^\[TEST\]/i.test(title);
  const excludeFromLunaEvidence = testPost
    || record.excludeFromLunaEvidence === true
    || metadata.excludeFromLunaEvidence === true;
  return {
    testPost,
    oneOffLiveTest: metadata.oneOffLiveTest === true || liveGate.mode === 'one_off_live_test',
    excludeFromLunaEvidence,
    lunaEvidencePolicy: excludeFromLunaEvidence ? 'exclude_test_post' : 'eligible_shadow_context',
  };
}

function normalizePublishLogContentPreview(content = '') {
  return ensurePublicMarketBriefDisclaimer(content)
    .replace(/<p>\s*&nbsp;\s*<\/p>/gi, '\n\n')
    .replace(/<\/p>\s*<p>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:p|strong|b|em|span|div)[^>]*>/gi, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildLunaEvidenceContentPreview(record = {}) {
  const title = String(record.title || '').replace(/^\[TEST\]\s*/i, '').trim();
  const content = normalizePublishLogContentPreview(record.content || '');
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^#EduX\b/i.test(line))
    .slice(0, 14);
  return [title ? `# ${title}` : null, ...lines].filter(Boolean).join('\n').slice(0, 1800);
}

function buildLunaEvidenceSummary(record = {}) {
  const preview = buildLunaEvidenceContentPreview(record);
  const lines = preview
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^#\s/.test(line))
    .filter((line) => !/^(?:⚠️?|#EduX)/u.test(line))
    .slice(0, 5);
  return lines.join(' | ').slice(0, 700);
}

function resolveDryRun(args = parseArgs()) {
  if (args.fixture || args.dryRunFlag) return true;
  return process.env.EDUX_DRY_RUN !== 'false';
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function kstNow() {
  return kst.now ? kst.now() : new Date();
}

function todayStartIso() {
  const now = kstNow();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start.toISOString();
}

function yyyymmdd() {
  const now = kstNow();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

function contentHash(content = '') {
  return crypto.createHash('sha256').update(String(content || '')).digest('hex').slice(0, 16);
}

function isCorePgPool(pgModule) {
  return Boolean(pgModule && (typeof pgModule.run === 'function' || typeof pgModule.getPool === 'function'));
}

async function dbQuery(pgModule, sql, params = [], schema = 'public') {
  if (!pgModule) return { rows: [], rowCount: 0, skipped: true, reason: 'pgPool_missing' };
  if (isCorePgPool(pgModule)) {
    const rows = await pgModule.query(schema, sql, params);
    return { rows: Array.isArray(rows) ? rows : rows?.rows || [], rowCount: Array.isArray(rows) ? rows.length : rows?.rowCount || 0 };
  }
  const result = await pgModule.query(sql, params);
  return { rows: result?.rows || [], rowCount: result?.rowCount || 0 };
}

async function dbRun(pgModule, sql, params = [], schema = 'public') {
  if (!pgModule) return { rows: [], rowCount: 0, skipped: true, reason: 'pgPool_missing' };
  if (isCorePgPool(pgModule)) {
    return pgModule.run(schema, sql, params);
  }
  const result = await pgModule.query(sql, params);
  return { rows: result?.rows || [], rowCount: result?.rowCount || 0 };
}

async function ensurePublishLogTable(pgModule) {
  if (process.env.EDUX_SKIP_DB === 'true') {
    return { ok: false, skipped: true, reason: 'EDUX_SKIP_DB=true' };
  }
  try {
    const result = await dbQuery(pgModule, `SELECT to_regclass('public.edux_publish_log') AS table_name`, [], 'public');
    const ok = result.rows?.[0]?.table_name === 'edux_publish_log';
    return { ok, reason: ok ? 'table_present' : 'migration_missing' };
  } catch (err) {
    return { ok: false, reason: `db_check_failed:${err?.message || err}` };
  }
}

async function checkAlreadyPublished(pgModule, { category, slot, dryRun }) {
  const table = await ensurePublishLogTable(pgModule);
  if (!table.ok) return { already: false, table };
  const statuses = dryRun ? ['dry_run'] : ['success'];
  try {
    const result = await dbQuery(pgModule, `
      SELECT id, status, created_at
      FROM edux_publish_log
      WHERE schedule_slot = $1
        AND category = $2
        AND status = ANY($3::text[])
        AND created_at >= $4
      ORDER BY created_at DESC
      LIMIT 1
    `, [slot, category, statuses, todayStartIso()], 'public');
    return { already: (result.rows || []).length > 0, table, row: result.rows?.[0] || null };
  } catch (err) {
    return { already: false, table, reason: `duplicate_check_failed:${err?.message || err}` };
  }
}

async function insertPublishLog(pgModule, record) {
  const table = await ensurePublishLogTable(pgModule);
  if (!table.ok) return { ok: false, skipped: true, reason: table.reason };

  const metadata = {
    ...(record.metadata || {}),
    ...resolvePublishLogSafetyMetadata(record),
    lunaEvidenceSummary: buildLunaEvidenceSummary(record),
    lunaEvidenceContentPreview: buildLunaEvidenceContentPreview(record),
    contentLen: String(record.content || '').length,
    imageCount: Array.isArray(record.imageUrls) ? record.imageUrls.length : 0,
    dryRun: record.status === 'dry_run',
  };

  try {
    await dbRun(pgModule, `
      INSERT INTO edux_publish_log
        (category, schedule_slot, post_id, post_url, title, content_hash, image_urls, status, error_msg, published_at, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11::jsonb)
    `, [
      record.category,
      record.slot,
      record.postId || null,
      record.postUrl || null,
      record.title || null,
      contentHash(record.content || ''),
      JSON.stringify(record.imageUrls || []),
      record.status,
      record.errorMsg || null,
      ['success', 'dry_run'].includes(record.status) ? new Date().toISOString() : null,
      JSON.stringify(metadata),
    ], 'public');
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `insert_failed:${err?.message || err}` };
  }
}

function validatePostQuality({ content, imagePaths = [], imageUrls = [], category = null, slot = null }) {
  const text = String(content || '');
  const sectionValidation = resolveSectionValidation(text, category, slot);
  const sectionCount = sectionValidation.headings.length;
  const requiredSectionCount = requiredSectionCountFor(sectionValidation.category, slot);
  const exactSectionCountRequired = ['kis_close', 'overseas_close'].includes(sectionValidation.category);
  const sectionCountOk = exactSectionCountRequired
    ? sectionCount === requiredSectionCount
    : sectionCount >= requiredSectionCount;
  const infoIssues = sectionValidation.category === 'crypto' ? validateCryptoInformationDensity(text) : [];
  const forbidden = [];
  if (/\bactivity\b/i.test(text) || /카테고리\s*:\s*activity/i.test(text)) forbidden.push('activity');
  if (/notion/i.test(text)) forbidden.push('notion');
  if (/좋아요|댓글/.test(text)) forbidden.push('likes_or_comments');
  forbidden.push(...detectPublicPostContentLeaks(text));
  if (!hasPublicMarketBriefDisclaimer(text)) forbidden.push('required_disclaimer_missing');
  const imageCount = Math.max(imagePaths.length, imageUrls.length);
  return {
    ok: text.length >= MIN_CONTENT_LEN && sectionCountOk && sectionValidation.missingSections.length === 0 && infoIssues.length === 0 && forbidden.length === 0 && imageCount >= MIN_IMAGES_PER_POST,
    contentLen: text.length,
    sectionCount,
    imageCount,
    category: sectionValidation.category,
    missingSections: [
      ...(sectionCountOk ? [] : [exactSectionCountRequired ? `section_count_exact:${sectionCount}/${requiredSectionCount}` : `section_count:${sectionCount}/${requiredSectionCount}`]),
      ...sectionValidation.missingSections,
    ],
    infoIssues,
    forbidden,
    requirements: {
      minContentLen: MIN_CONTENT_LEN,
      minSections: requiredSectionCount,
      minImages: MIN_IMAGES_PER_POST,
    },
  };
}

function stripImagePlaceholders(content) {
  return ensurePublicMarketBriefDisclaimer(content)
    .replace(/\n?(?:③\s*)?\[이미지 2장 플레이스홀더 — 실제 URL은 후처리\]\n?/g, '\n📌 핵심 데이터 체크포인트\n')
    .replace(/\n?(?:③\s*)?\[이미지 플레이스홀더\]\n?/g, '\n📌 핵심 데이터 체크포인트\n')
    .replace(/\[이미지 2장 플레이스홀더 — 실제 URL은 후처리\]/g, '')
    .replace(/\[이미지 플레이스홀더\]/g, '')
    .replace(/차트 이미지는[^\n]*(?:\n[^\n]*){0,2}/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function replaceImagePlaceholders(content, imageUrls = []) {
  const replacement = imageUrls.length > 0
    ? imageUrls.map((url, index) => `이미지 ${index + 1}: ${url}`).join('\n')
    : '';
  const replaced = String(content || '')
    .replace(/\[이미지 2장 플레이스홀더 — 실제 URL은 후처리\]/g, replacement)
    .replace(/\[이미지 플레이스홀더\]/g, replacement);
  return imageUrls.length > 0 ? replaced : stripImagePlaceholders(replaced);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cleanInlineMarkdown(value) {
  return String(value || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

function isMarkdownTableLine(line) {
  return /^\|.+\|$/.test(String(line || '').trim());
}

function isMarkdownTableDivider(line) {
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(String(line || '').trim());
}

function parseMarkdownTableRow(line) {
  return String(line || '')
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cleanInlineMarkdown(cell));
}

function renderMarkdownTable(headerLine, bodyLines) {
  const headers = parseMarkdownTableRow(headerLine);
  const rows = bodyLines.map(parseMarkdownTableRow).filter((row) => row.some(Boolean));
  if (!headers.length || !rows.length) return null;
  return rows.map((row) => {
    const label = row[0] || '항목';
    const details = headers
      .slice(1)
      .map((header, offset) => {
        const value = row[offset + 1];
        return value ? `${header} ${value}` : null;
      })
      .filter(Boolean)
      .join(' · ');
    return `<p>• ${escapeHtml(label)}${details ? ` — ${escapeHtml(details)}` : ''}</p>`;
  }).join('\n');
}

function renderList(items, ordered = false) {
  return items.map((item, index) => {
    const prefix = ordered ? `${index + 1}.` : '•';
    return `<p>${prefix} ${escapeHtml(cleanInlineMarkdown(item))}</p>`;
  }).join('\n');
}

function formatContentForEduXWeb(content) {
  const cleaned = stripImagePlaceholders(content);
  const lines = cleaned.split(/\r?\n/);
  const html = [];

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line) continue;

    if (isMarkdownTableLine(line) && isMarkdownTableDivider(lines[i + 1] || '')) {
      const bodyLines = [];
      i += 2;
      while (i < lines.length && isMarkdownTableLine(lines[i])) {
        bodyLines.push(lines[i]);
        i += 1;
      }
      i -= 1;
      const table = renderMarkdownTable(line, bodyLines);
      if (table) {
        html.push(table);
        continue;
      }
    }

    const unordered = line.match(/^[-*]\s+(.+)$/);
    if (unordered) {
      const items = [unordered[1]];
      while (i + 1 < lines.length) {
        const next = lines[i + 1].trim();
        const match = next.match(/^[-*]\s+(.+)$/);
        if (!match) break;
        items.push(match[1]);
        i += 1;
      }
      html.push(renderList(items, false));
      continue;
    }

    const ordered = line.match(/^\d+\.\s+(.+)$/);
    if (ordered) {
      const items = [ordered[1]];
      while (i + 1 < lines.length) {
        const next = lines[i + 1].trim();
        const match = next.match(/^\d+\.\s+(.+)$/);
        if (!match) break;
        items.push(match[1]);
        i += 1;
      }
      html.push(renderList(items, true));
      continue;
    }

    const cleanedLine = cleanInlineMarkdown(normalizeSectionHeadingLine(line));
    const safe = escapeHtml(cleanedLine);
    if (isSectionHeadingLine(line)) {
      if (html.length > 0) html.push(SECTION_BLOCK_SPACER_HTML);
      html.push(`<h3>${safe}</h3>`);
    } else {
      html.push(`<p>${safe}</p>`);
    }
  }

  return html.join('\n');
}

function writeDryRunArtifact({ category, slot, title, content, imagePaths = [], metadata = {} }) {
  const safeContent = ensurePublicMarketBriefDisclaimer(content);
  const artifactDir = metadata?.fixture === true
    ? path.join(DRY_RUN_DIR, 'fixture')
    : DRY_RUN_DIR;
  ensureDir(artifactDir);
  const stamp = `${yyyymmdd()}-${slot}-${category}`;
  const base = path.join(artifactDir, stamp);
  const jsonPath = `${base}.json`;
  const mdPath = `${base}.md`;
  const payload = {
    category,
    slot,
    dryRun: true,
    title,
    contentLen: String(safeContent || '').length,
    imagePaths,
    metadata,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  const imageSection = imagePaths.length
    ? `\n\n## Images\n${imagePaths.map((p) => `- ${p}`).join('\n')}`
    : '';
  fs.writeFileSync(mdPath, `# ${title || `${category} ${slot}`}\n\n${safeContent || ''}${imageSection}\n`, 'utf8');
  return { jsonPath, mdPath };
}

function loadPromotionGateReport() {
  try {
    if (!fs.existsSync(PROMOTION_GATE_REPORT)) return null;
    return JSON.parse(fs.readFileSync(PROMOTION_GATE_REPORT, 'utf8'));
  } catch {
    return null;
  }
}

const PROMOTION_GATE_REQUIRED_CHECKS = 7;
const PROMOTION_GATE_MAX_AGE_MS = 24 * 3600 * 1000;

function isTruthyEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function isPromotionGateRequired() {
  return String(process.env.EDUX_REQUIRE_PROMOTION_GATE || '').trim().toLowerCase() !== 'false';
}

function promotionReportBlockingReasons(report) {
  const reasons = [];
  if (!report?.allPass) reasons.push('promotion gate report is missing or not PASS');
  if (report?.fixture || report?.mode === 'fixture') reasons.push('promotion gate report is fixture-only');
  if (!Array.isArray(report?.checks) || report.checks.length < PROMOTION_GATE_REQUIRED_CHECKS) {
    reasons.push(`promotion gate report has fewer than ${PROMOTION_GATE_REQUIRED_CHECKS} checks`);
  }
  const generatedAt = report?.generatedAt ? Date.parse(report.generatedAt) : NaN;
  if (!Number.isFinite(generatedAt) || Date.now() - generatedAt > PROMOTION_GATE_MAX_AGE_MS) {
    reasons.push('promotion gate report is stale');
  }
  return reasons;
}

function promotionReportSummary(report) {
  return report
    ? {
      generatedAt: report.generatedAt,
      mode: report.mode || null,
      fixture: Boolean(report.fixture),
      summary: report.summary,
      allPass: report.allPass,
      checkCount: Array.isArray(report.checks) ? report.checks.length : 0,
      blockingReasons: promotionReportBlockingReasons(report),
    }
    : null;
}

function assertLivePublishAllowed({ tableOk = false, oneOffLiveTest = false, fixture = false } = {}) {
  const report = loadPromotionGateReport();
  const promotionGateRequired = isPromotionGateRequired();

  if (oneOffLiveTest) {
    const reasons = [];
    if (process.env.EDUX_DRY_RUN !== 'false') reasons.push('EDUX_DRY_RUN is not false');
    if (process.env.EDUX_LIVE_PUBLISH_APPROVED !== 'true') reasons.push('EDUX_LIVE_PUBLISH_APPROVED is not true');
    if (process.env.EDUX_ONE_OFF_LIVE_TEST_APPROVED !== 'true') reasons.push('EDUX_ONE_OFF_LIVE_TEST_APPROVED is not true');
    if (fixture) reasons.push('one-off live test cannot use fixture data');
    if (!tableOk) reasons.push('edux_publish_log table is unavailable');
    return {
      ok: reasons.length === 0,
      mode: 'one_off_live_test',
      reasons,
      warnings: promotionGateRequired && promotionReportBlockingReasons(report).length !== 0
        ? ['promotion gate is not PASS; one-off live test override active']
        : [],
      promotionGateRequired,
      promotionReport: promotionReportSummary(report),
    };
  }

  const reasons = [];
  if (process.env.EDUX_DRY_RUN !== 'false') reasons.push('EDUX_DRY_RUN is not false');
  if (process.env.EDUX_LIVE_PUBLISH_APPROVED !== 'true') reasons.push('EDUX_LIVE_PUBLISH_APPROVED is not true');
  if (promotionGateRequired) {
    if (process.env.EDUX_PROMOTION_GATE_PASSED !== 'true') reasons.push('EDUX_PROMOTION_GATE_PASSED is not true');
    reasons.push(...promotionReportBlockingReasons(report));
  }
  if (!tableOk) reasons.push('edux_publish_log table is unavailable');
  return {
    ok: reasons.length === 0,
    mode: promotionGateRequired ? 'promotion_gate' : 'live_approved',
    reasons,
    warnings: [],
    promotionGateRequired,
    promotionReport: promotionReportSummary(report),
  };
}

function shouldSendPublishSuccessTelegram({ args = {}, liveGate = {} } = {}) {
  const oneOffLiveTest = args.oneOffLiveTest === true || liveGate?.mode === 'one_off_live_test';
  if (!oneOffLiveTest) return true;
  return process.env.EDUX_NOTIFY_ONE_OFF_LIVE_TEST === 'true';
}

function emitJsonIfRequested(enabled, payload) {
  if (enabled) console.log(JSON.stringify(payload, null, 2));
}

function redact(value) {
  if (!value) return null;
  const text = String(value);
  if (text.length <= 4) return '***';
  return `${text.slice(0, 2)}***${text.slice(-2)}`;
}

function postUrlFor(baseUrl, postId) {
  const base = String(baseUrl || 'https://edu-x.io').replace(/\/$/, '');
  const webBase = base.includes('pulse.edu-x.io') ? 'https://edu-x.io' : base;
  return `${webBase}/community/posts/${postId}`;
}

module.exports = {
  OUTPUT_DIR,
  DRY_RUN_DIR,
  PROMOTION_GATE_REPORT,
  INTEGRATION_REPORT,
  MIN_CONTENT_LEN,
  MIN_IMAGES_PER_POST,
  parseArgs,
  resolvePublishLogSafetyMetadata,
  normalizePublishLogContentPreview,
  buildLunaEvidenceContentPreview,
  buildLunaEvidenceSummary,
  resolveDryRun,
  ensureDir,
  dbQuery,
  dbRun,
  ensurePublishLogTable,
  checkAlreadyPublished,
  insertPublishLog,
  validatePostQuality,
  stripImagePlaceholders,
  replaceImagePlaceholders,
  sanitizePublicPostContent,
  ensurePublicMarketBriefDisclaimer,
  hasPublicMarketBriefDisclaimer,
  detectPublicPostContentLeaks,
  formatContentForEduXWeb,
  writeDryRunArtifact,
  loadPromotionGateReport,
  isPromotionGateRequired,
  assertLivePublishAllowed,
  shouldSendPublishSuccessTelegram,
  emitJsonIfRequested,
  redact,
  postUrlFor,
};
