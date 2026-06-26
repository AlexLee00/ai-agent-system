#!/usr/bin/env node
// @ts-nocheck
'use strict';

/**
 * runtime-edux-daily-digest.ts — Edu-X 일일 게시물 텔레그램 다이제스트
 *
 * 발송 시각 기준 직전 24시간 success 게시물을 읽어 요약 메시지를 만든다.
 * DB는 SELECT만 수행하고, Telegram 발송은 EDUX_DIGEST_DRY_RUN=true 또는
 * --dry-run에서는 실행하지 않는다.
 */

const path = require('path');
const fs = require('fs');
const env = require('../../../packages/core/lib/env');
require('../../../packages/core/lib/kst');
const { dbQuery } = require('../lib/edux-runtime-support.ts');

let pgPool;
try {
  pgPool = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/pg-pool'));
} catch { pgPool = null; }

const GOOGLE_PLAY_URL = 'https://play.google.com/store/apps/details?id=com.wcapartners.edux';
const EDUX_DOWNLOAD_URL = 'https://onelink.to/vmpdmz';
const DEFAULT_PLAY_URL = process.env.EDUX_DIGEST_PLAY_URL || EDUX_DOWNLOAD_URL;
const DEFAULT_PREVIEW_URL = process.env.EDUX_DIGEST_PREVIEW_URL || GOOGLE_PLAY_URL;
const DEFAULT_THUMBNAIL_PATH = path.join(env.PROJECT_ROOT, 'bots/edu-x/assets/edux-digest-thumbnail.png');
const TELEGRAM_PHOTO_CAPTION_LIMIT = 1024;

function parseArgs(argv = process.argv.slice(2)) {
  const args = { dryRun: false, json: false };
  for (const item of argv) {
    if (item === '--dry-run') args.dryRun = true;
    else if (item === '--json') args.json = true;
  }
  return args;
}

function escapeHtml(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlAttr(value = '') {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

function linkTo(url, label) {
  const href = String(url || '').trim();
  const text = escapeHtml(label || href);
  if (!href) return text;
  return `<a href="${escapeHtmlAttr(href)}">${text}</a>`;
}

function unescapeBasicHtml(value = '') {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function isTruthyEnv(value, defaultValue = false) {
  if (value == null || value === '') return defaultValue;
  return !/^(0|false|no|off)$/i.test(String(value).trim());
}

function displayMmdd(mmdd = '') {
  const text = String(mmdd || '').trim();
  const match = text.match(/^(\d{2})\/(\d{2})$/);
  return match ? `${match[1]} / ${match[2]}` : text;
}

function categoryLabel(category = '', assetLine = '', scheduleSlot = '') {
  const categoryText = String(category || '').toLowerCase();
  const assetText = String(assetLine || '').trim();
  const labels = {
    overseas: String(scheduleSlot || '') === '0630' ? '미국 마감' : '미국 증시',
    kis: String(scheduleSlot || '') === '1600' ? '국내 마감' : '국내 증시',
    crypto: '비트코인',
  };
  const label = labels[categoryText] || '';
  if (!label) return '';
  if (assetText.startsWith(label)) return '';
  if (categoryText === 'crypto' && assetText.startsWith('비트코인')) return '';
  return label;
}

function digestItemTitle(row = {}) {
  if (String(row.category || '').toLowerCase() === 'kis' && String(row.scheduleSlot || '') === '1600') {
    return [categoryLabel(row.category, row.assetLine, row.scheduleSlot) || '국내 마감', row.assetLine || row.title || '시장 정보']
      .filter(Boolean)
      .join(' ');
  }
  if (String(row.category || '').toLowerCase() === 'overseas' && /마감/.test(String(row.title || ''))) {
    return ['미국 마감', row.assetLine || row.title || '시장 정보']
      .filter(Boolean)
      .join(' ');
  }
  return [categoryLabel(row.category, row.assetLine, row.scheduleSlot), row.assetLine || row.title || '시장 정보']
    .filter(Boolean)
    .join(' ');
}

function mmddFromDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const month = parts.find((part) => part.type === 'month')?.value || '01';
  const day = parts.find((part) => part.type === 'day')?.value || '01';
  return `${month}/${day}`;
}

function digestWindow(referenceDate = new Date()) {
  const end = new Date(referenceDate);
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  return { start, end, mmdd: mmddFromDate(end) };
}

function normalizeMetadata(metadata) {
  if (!metadata) return {};
  if (typeof metadata === 'object') return metadata;
  try { return JSON.parse(String(metadata)); } catch { return {}; }
}

function slotLabel(slot) {
  const text = String(slot || '').padStart(4, '0');
  if (!/^\d{4}$/.test(text)) return text || '시간 미정';
  return `${text.slice(0, 2)}:${text.slice(2)}`;
}

function extractAssetLine(title = '') {
  const parts = String(title || '').split('|');
  return String(parts[1] || parts[0] || '').trim();
}

function extractSummaryLine(metadata = {}) {
  const text = String(metadata?.lunaEvidenceSummary || '').trim();
  if (!text) return '';
  const parts = text.split('|').map((part) => part.trim()).filter(Boolean);
  return summarizeOneLine(parts[1] || parts[2] || '');
}

function inferStrengthPhrase(value = '') {
  const text = String(value || '');
  if (/대형주\s*우위/.test(text)) return '대형주 강세';
  if (/대형주\s*중심의\s*상대\s*강세/.test(text)) return '대형주 강세';
  const sectorMatch = text.match(/([가-힣A-Za-z0-9·\/]+)\s*(?:업종|섹터|분야)?\s*(?:강세|우위|주도)/);
  if (sectorMatch?.[1]) {
    const label = sectorMatch[1]
      .replace(/^(오늘|국내|증시|시장|지수|수급|대형)$/, '$1')
      .trim();
    if (label && !/^(코스피|코스닥|지수|시장|상대|단기|장중|오늘|수급)$/.test(label)) return `${label} 강세`;
  }
  return '';
}

function normalizeIndexSummary(value = '', source = '') {
  const text = String(value || '');
  const items = [];
  const pattern = /(코스피|코스닥|나스닥|S&P500)\s*([0-9,]+(?:\.\d+)?)\s*(?:으로|로|은|는)?\s*([+-]\d+(?:\.\d+)?%)\s*(상승|하락)/g;
  for (const match of text.matchAll(pattern)) {
    items.push(`${match[1]} ${match[2]} ${match[3]} ${match[4]}`);
  }
  if (items.length === 0) return '';
  const strength = inferStrengthPhrase(`${source || ''} ${text}`);
  if (strength) items.push(strength);
  return items.join(', ');
}

function summarizeOneLine(value = '', maxLen = 72) {
  const sourceText = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  let text = sourceText;
  if (!text) return '';
  const splitters = [
    /[.。]\s+/,
    /\s+확인됐습니다\.\s*/,
    /\s+관측됐습니다\.\s*/,
    /\s+마감했습니다\.\s*/,
    /\s+거래 중이며\s*/,
    /\s+속\s+/,
  ];
  for (const splitter of splitters) {
    const first = text.split(splitter)[0]?.trim();
    if (first && first.length >= 18 && first.length < text.length) {
      text = first;
      break;
    }
  }
  text = text
    .replace(/^(BTC\/USDT|ETH\/USDT|코스피|코스닥|S&P500|Nasdaq|나스닥|원\/달러)는\s+/i, '$1 ')
    .replace(/(코스피|코스닥|나스닥|S&P500|BTC\/USDT|ETH\/USDT)은\s+/g, '$1 ')
    .replace(/\s+상승 마감했고,\s+/g, ' 상승·')
    .replace(/\s+하락 마감했고,\s+/g, ' 하락·')
    .replace(/상승 마감/g, '상승')
    .replace(/하락 마감/g, '하락')
    .replace(/\s+급등했고,\s+/g, ' 급등·')
    .replace(/\s+급락했고,\s+/g, ' 급락·')
    .replace(/입니다$/g, '')
    .replace(/했습니다$/g, '')
    .replace(/합니다$/g, '')
    .replace(/됩니다$/g, '')
    .replace(/입니다\.$/g, '')
    .replace(/했습니다\.$/g, '')
    .replace(/합니다\.$/g, '')
    .replace(/됩니다\.$/g, '')
    .trim();
  const indexSummary = normalizeIndexSummary(text, sourceText);
  if (indexSummary) text = indexSummary;
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen + 1);
  const boundary = Math.max(
    cut.lastIndexOf(','),
    cut.lastIndexOf('，'),
    cut.lastIndexOf(' '),
  );
  const shortened = boundary >= 36 ? cut.slice(0, boundary) : text.slice(0, maxLen);
  return `${shortened.replace(/[,\s]+$/g, '')}…`;
}

function extractTitleDate(title = '', publishedAt = null) {
  const match = String(title || '').trim().match(/^(\d{2}\/\d{2})\b/);
  if (match) return match[1];
  if (publishedAt) return mmddFromDate(new Date(publishedAt));
  return mmddFromDate(new Date());
}

function normalizeDigestPostUrl(url = '') {
  const text = String(url || '').trim();
  if (!text) return '';
  // Existing publish logs may contain the API-style route; the web share link uses /community/{id}.
  return text.replace('/community/posts/', '/community/');
}

function parseDigestRow(row = {}) {
  const metadata = normalizeMetadata(row.metadata);
  return {
    scheduleSlot: row.schedule_slot || row.scheduleSlot || '',
    category: row.category || '',
    title: row.title || '',
    postUrl: normalizeDigestPostUrl(row.post_url || row.postUrl || ''),
    publishedAt: row.published_at || row.publishedAt || null,
    dateMmdd: extractTitleDate(row.title, row.published_at || row.publishedAt),
    assetLine: extractAssetLine(row.title),
    summaryLine: extractSummaryLine(metadata),
    timeLabel: slotLabel(row.schedule_slot || row.scheduleSlot),
  };
}

function buildDigestMessage(rows = [], options = {}) {
  const parsed = rows
    .map(parseDigestRow)
    .filter((row) => row.postUrl)
    .sort((a, b) => new Date(b.publishedAt || 0).getTime() - new Date(a.publishedAt || 0).getTime());
  const dateMmdd = options.dateMmdd || parsed[0]?.dateMmdd || mmddFromDate(new Date());
  const lines = [`<b>🔥[${escapeHtml(displayMmdd(dateMmdd))}]  오늘 꼭 알아야 할 시장 정보 총정리🔥</b>`];

  for (const row of parsed) {
    const assetTitle = digestItemTitle(row);
    lines.push('');
    lines.push(`📊<b>${escapeHtml(assetTitle)}</b>`);
    lines.push(linkTo(row.postUrl, `[${row.summaryLine || '게시글 보기'}]`));
  }

  lines.push('');
  lines.push('📌 다양한 실시간 정보는 EduX 커뮤니티에 있습니다');
  const playUrl = options.playUrl == null ? DEFAULT_PLAY_URL : String(options.playUrl || '');
  if (playUrl) {
    lines.push('');
    lines.push(linkTo(playUrl, 'Edu-X 에듀엑스 다운로드 👉'));
  }
  return lines.join('\n');
}

function thumbnailPath() {
  return process.env.EDUX_DIGEST_THUMBNAIL_PATH || DEFAULT_THUMBNAIL_PATH;
}

function shouldSendThumbnail(options = {}) {
  if (options.sendThumbnail === false) return false;
  if (!isTruthyEnv(process.env.EDUX_DIGEST_SEND_THUMBNAIL, false)) return false;
  return fs.existsSync(options.thumbnailPath || thumbnailPath());
}

function shouldShowLinkPreview() {
  return isTruthyEnv(process.env.EDUX_DIGEST_LINK_PREVIEW, false);
}

function resolveTelegramChannelId(options = {}) {
  if (options.chatId) return String(options.chatId);
  const target = String(options.telegramTarget || process.env.EDUX_DIGEST_TELEGRAM_TARGET || '').trim().toLowerCase();
  if (target === 'test') {
    return process.env.EDUX_DIGEST_TELEGRAM_CHANNEL_ID_TEST || process.env.EDUX_DIGEST_TELEGRAM_CHANNEL_ID || '';
  }
  if (target === 'live') {
    return process.env.EDUX_DIGEST_TELEGRAM_CHANNEL_ID_LIVE || process.env.EDUX_DIGEST_TELEGRAM_CHANNEL_ID || '';
  }
  return process.env.EDUX_DIGEST_TELEGRAM_CHANNEL_ID
    || process.env.EDUX_DIGEST_TELEGRAM_CHANNEL_ID_LIVE
    || process.env.EDUX_DIGEST_TELEGRAM_CHANNEL_ID_TEST
    || '';
}

function resolveTelegramTarget(options = {}) {
  return String(options.telegramTarget || process.env.EDUX_DIGEST_TELEGRAM_TARGET || 'legacy').trim().toLowerCase();
}

function buildThumbnailCaption(text = '', options = {}) {
  if (!options.compact && String(text).length <= TELEGRAM_PHOTO_CAPTION_LIMIT) return text;
  const header = String(text).split('\n').find((line) => line.trim()) || '<b>Edu-X 오늘의 시장 정보</b>';
  const playUrl = options.playUrl == null ? DEFAULT_PLAY_URL : String(options.playUrl || '');
  const cta = playUrl ? linkTo(playUrl, 'Edu-X 에듀엑스 다운로드 👉') : '';
  const lines = [header];
  const blockPattern = /📊<b>(.*?)<\/b>\n<a href="([^"]+)">\[(.*?)\]<\/a>/g;
  for (const match of String(text).matchAll(blockPattern)) {
    const title = unescapeBasicHtml(String(match[1] || '').replace(/<[^>]+>/g, '').trim());
    const url = String(match[2] || '').trim();
    const candidate = `📊 ${linkTo(url, title || '게시글 보기')}`;
    const next = [...lines, '', candidate, ...(cta ? ['', cta] : [])].join('\n');
    if (next.length > TELEGRAM_PHOTO_CAPTION_LIMIT) break;
    lines.push('', candidate);
  }
  if (lines.length === 1) {
    lines.push('', '오늘의 Edu-X 시장 요약입니다.');
  }
  if (playUrl) {
    lines.push('', cta);
  }
  return lines.join('\n').slice(0, TELEGRAM_PHOTO_CAPTION_LIMIT);
}

async function sendTelegramMessage(token, chatId, text, options = {}) {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
  };
  if (options.replyToMessageId) body.reply_to_message_id = options.replyToMessageId;
  if (options.disablePreview || !shouldShowLinkPreview()) {
    body.link_preview_options = { is_disabled: true };
  } else {
    body.link_preview_options = {
      is_disabled: false,
      url: options.previewUrl == null ? DEFAULT_PREVIEW_URL : String(options.previewUrl || '') || undefined,
      prefer_large_media: true,
      show_above_text: false,
    };
  }
  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await resp.json().catch(() => ({ ok: false, description: `HTTP ${resp.status}` }));
  if (!result.ok) throw new Error(result.description || `HTTP ${resp.status}`);
  return result;
}

async function sendTelegramPhotoDigest(token, chatId, text, options = {}) {
  const imagePath = options.thumbnailPath || thumbnailPath();
  const caption = buildThumbnailCaption(text, { ...options, compact: true });
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('photo', new Blob([fs.readFileSync(imagePath)], { type: 'image/png' }), path.basename(imagePath));
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');

  const resp = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: 'POST',
    body: form,
  });
  const photoResult = await resp.json().catch(() => ({ ok: false, description: `HTTP ${resp.status}` }));
  if (!photoResult.ok) throw new Error(photoResult.description || `HTTP ${resp.status}`);

  return {
    ...photoResult,
    deliveryMode: 'photo_caption_compact',
    thumbnail_result: photoResult.result,
  };
}

async function fetchDigestRows(pgModule = pgPool, options = {}) {
  const reference = options.referenceDate || (process.env.EDUX_DIGEST_NOW ? new Date(process.env.EDUX_DIGEST_NOW) : new Date());
  const window = digestWindow(reference);
  const result = await dbQuery(pgModule, `
    SELECT schedule_slot, category, title, post_url, metadata, published_at
    FROM edux_publish_log
    WHERE status = 'success'
      AND published_at >= $1
      AND published_at < $2
    ORDER BY published_at DESC
  `, [window.start.toISOString(), window.end.toISOString()], 'public');
  if (result?.skipped) {
    throw new Error(`digest_db_unavailable:${result.reason || 'unknown'}`);
  }
  return { rows: result.rows || [], window };
}

async function sendTelegramDigest(text, options = {}) {
  const token = process.env.EDUX_DIGEST_TELEGRAM_BOT_TOKEN;
  const chatId = resolveTelegramChannelId(options);
  if (!token || !chatId) {
    throw new Error('EDUX_DIGEST_TELEGRAM_* 미설정 — 발송 불가');
  }
  if (shouldSendThumbnail(options)) {
    return sendTelegramPhotoDigest(token, chatId, text, options);
  }
  return sendTelegramMessage(token, chatId, text, options);
}

async function runDailyDigest(options = {}) {
  const args = options.args || parseArgs();
  const dryRun = options.dryRun ?? (process.env.EDUX_DIGEST_DRY_RUN === 'true' || args.dryRun);
  const { rows, window } = await fetchDigestRows(options.pgPool || pgPool, options);
  if (rows.length === 0) {
    const result = {
      ok: true,
      skipped: true,
      reason: 'no_success_posts_in_window',
      dryRun,
      count: 0,
      window: { start: window.start.toISOString(), end: window.end.toISOString() },
    };
    console.log('[digest] 직전 24h success 0건 — 발송 skip');
    return result;
  }

  const playUrl = options.playUrl == null ? DEFAULT_PLAY_URL : String(options.playUrl || '');
  const text = buildDigestMessage(rows, { dateMmdd: window.mmdd, playUrl });
  if (dryRun) {
    console.log(`[digest][DRY-RUN]\n${text}`);
    return {
      ok: true,
      dryRun: true,
      sent: false,
      count: rows.length,
      text,
      window: { start: window.start.toISOString(), end: window.end.toISOString() },
    };
  }

  const previewUrl = options.previewUrl == null ? DEFAULT_PREVIEW_URL : String(options.previewUrl || '');
  const sendOptions = {
    previewUrl,
    telegramTarget: options.telegramTarget,
    chatId: options.chatId,
    sendThumbnail: options.sendThumbnail,
    thumbnailPath: options.thumbnailPath,
  };
  const telegramResult = await sendTelegramDigest(text, sendOptions);
  console.log(`[digest] 발송 완료 (${rows.length}건)`);
  return {
    ok: true,
    dryRun: false,
    sent: true,
    count: rows.length,
    telegramMessageId: telegramResult?.result?.message_id || null,
    telegramThumbnailMessageId: telegramResult?.thumbnail_result?.message_id || null,
    telegramDeliveryMode: telegramResult?.deliveryMode || 'message',
    telegramTarget: resolveTelegramTarget(sendOptions),
    telegramPreviewUrl: shouldShowLinkPreview() ? previewUrl || null : null,
    window: { start: window.start.toISOString(), end: window.end.toISOString() },
  };
}

if (require.main === module) {
  const args = parseArgs();
  runDailyDigest({ args })
    .then((result) => {
      if (args.json) console.log(JSON.stringify(result, null, 2));
    })
    .catch((err) => {
      console.error('[digest] 오류:', err?.message || err);
      if (args.json) console.log(JSON.stringify({ ok: false, error: err?.message || String(err) }, null, 2));
      process.exit(1);
    });
}

module.exports = {
  parseArgs,
  digestWindow,
  parseDigestRow,
  buildDigestMessage,
  summarizeOneLine,
  normalizeDigestPostUrl,
  displayMmdd,
  escapeHtml,
  linkTo,
  fetchDigestRows,
  runDailyDigest,
  sendTelegramDigest,
  buildThumbnailCaption,
  shouldSendThumbnail,
  resolveTelegramChannelId,
};
