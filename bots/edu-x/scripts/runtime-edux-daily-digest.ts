#!/usr/bin/env node
// @ts-nocheck
'use strict';

/**
 * runtime-edux-daily-digest.ts — Edu-X 일일 게시물 텔레그램 다이제스트
 *
 * 직전 24시간 success 게시물을 읽어 10:00 KST 기준 요약 메시지를 만든다.
 * DB는 SELECT만 수행하고, Telegram 발송은 EDUX_DIGEST_DRY_RUN=true 또는
 * --dry-run에서는 실행하지 않는다.
 */

const path = require('path');
const env = require('../../../packages/core/lib/env');
require('../../../packages/core/lib/kst');
const { dbQuery } = require('../lib/edux-runtime-support.ts');

let pgPool;
try {
  pgPool = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/pg-pool'));
} catch { pgPool = null; }

const DEFAULT_PLAY_URL = process.env.EDUX_DIGEST_PLAY_URL || '';

function parseArgs(argv = process.argv.slice(2)) {
  const args = { dryRun: false, json: false };
  for (const item of argv) {
    if (item === '--dry-run') args.dryRun = true;
    else if (item === '--json') args.json = true;
  }
  return args;
}

function kstDateString(date = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
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
  const kstDate = kstDateString(referenceDate);
  const end = new Date(`${kstDate}T10:00:00+09:00`);
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
  return parts[1] || parts[2] || '';
}

function extractTitleDate(title = '', publishedAt = null) {
  const match = String(title || '').trim().match(/^(\d{2}\/\d{2})\b/);
  if (match) return match[1];
  if (publishedAt) return mmddFromDate(new Date(publishedAt));
  return mmddFromDate(new Date());
}

function parseDigestRow(row = {}) {
  const metadata = normalizeMetadata(row.metadata);
  return {
    scheduleSlot: row.schedule_slot || row.scheduleSlot || '',
    category: row.category || '',
    title: row.title || '',
    postUrl: row.post_url || row.postUrl || '',
    publishedAt: row.published_at || row.publishedAt || null,
    dateMmdd: extractTitleDate(row.title, row.published_at || row.publishedAt),
    assetLine: extractAssetLine(row.title),
    summaryLine: extractSummaryLine(metadata),
    timeLabel: slotLabel(row.schedule_slot || row.scheduleSlot),
  };
}

function buildDigestMessage(rows = [], options = {}) {
  const parsed = rows.map(parseDigestRow).filter((row) => row.postUrl);
  const dateMmdd = options.dateMmdd || parsed[0]?.dateMmdd || mmddFromDate(new Date());
  const lines = [`🔥[${dateMmdd}] 오늘 꼭 알아야 할 시장 정보 총정리🔥`];

  for (const row of parsed) {
    lines.push('');
    lines.push(`📊${row.assetLine || row.title || '시장 정보'} (${row.timeLabel} 요약)`);
    if (row.summaryLine) lines.push(row.summaryLine);
    lines.push(row.postUrl);
  }

  lines.push('');
  lines.push('📌 다양한 실시간 정보는 EduX 커뮤니티에서 확인하세요');
  const playUrl = options.playUrl == null ? DEFAULT_PLAY_URL : String(options.playUrl || '');
  if (playUrl) lines.push(`📲 EDU-X 앱 다운로드 👉 ${playUrl}`);
  return lines.join('\n');
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
    ORDER BY published_at ASC
  `, [window.start.toISOString(), window.end.toISOString()], 'public');
  if (result?.skipped) {
    throw new Error(`digest_db_unavailable:${result.reason || 'unknown'}`);
  }
  return { rows: result.rows || [], window };
}

async function sendTelegramDigest(text) {
  const token = process.env.EDUX_DIGEST_TELEGRAM_BOT_TOKEN;
  const chatId = process.env.EDUX_DIGEST_TELEGRAM_CHANNEL_ID;
  if (!token || !chatId) {
    throw new Error('EDUX_DIGEST_TELEGRAM_* 미설정 — 발송 불가');
  }
  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: false,
    }),
  });
  const result = await resp.json().catch(() => ({ ok: false, description: `HTTP ${resp.status}` }));
  if (!result.ok) throw new Error(result.description || `HTTP ${resp.status}`);
  return result;
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

  const text = buildDigestMessage(rows, { dateMmdd: window.mmdd, playUrl: options.playUrl });
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

  const telegramResult = await sendTelegramDigest(text);
  console.log(`[digest] 발송 완료 (${rows.length}건)`);
  return {
    ok: true,
    dryRun: false,
    sent: true,
    count: rows.length,
    telegramMessageId: telegramResult?.result?.message_id || null,
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
  fetchDigestRows,
  runDailyDigest,
  sendTelegramDigest,
};
