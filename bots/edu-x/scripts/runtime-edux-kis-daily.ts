#!/usr/bin/env node
// @ts-nocheck
'use strict';

/**
 * runtime-edux-kis-daily.ts — 국내주식 일일 브리핑 발행
 *
 * 슬롯: 09:00 KST (장시작 30분 전)
 * Dry-run: EDUX_DRY_RUN=true (기본)
 */

const path = require('path');
const crypto = require('crypto');
const env = require('../../../packages/core/lib/env');
const kst = require('../../../packages/core/lib/kst');

const { getEduxClient } = require('../lib/edux-client');
const { uploadMultiple } = require('../lib/edux-image-uploader');
const { formatPost } = require('../lib/edux-formatter');
const { generateKisImages, cleanupOldImages } = require('../lib/edux-image-generator');

let telegramSender;
try {
  telegramSender = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/telegram-sender'));
} catch { telegramSender = null; }

let pgPool;
try {
  pgPool = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/pg-pool'));
} catch { pgPool = null; }

const DRY_RUN = process.env.EDUX_DRY_RUN !== 'false';
const CATEGORY = 'kis';
const SLOT = '0900';

// ─── KIS 데이터 수집 ──────────────────────────────────────────────

async function fetchKisMarketData() {
  try {
    if (!pgPool) return {};
    // 루나팀 KIS WebSocket 데이터에서 최신 코스피/코스닥 조회
    const result = await pgPool.query(`
      SELECT symbol, signal_direction, score, evidence_summary, raw_ref, created_at
      FROM investment.signals
      WHERE strategy_family IN ('community_sentiment', 'technical_analysis')
        AND market = 'domestic'
        AND created_at >= NOW() - INTERVAL '12 hours'
      ORDER BY created_at DESC
      LIMIT 20
    `);
    const rows = result?.rows || [];

    // KIS 데이터에서 지수 추출 (raw_ref에 포함)
    const kisRow = rows.find((r) => r.raw_ref?.kospi_index);
    return {
      kospi_index: kisRow?.raw_ref?.kospi_index || null,
      kospi_change: kisRow?.raw_ref?.kospi_change || null,
      kosdaq_index: kisRow?.raw_ref?.kosdaq_index || null,
      kosdaq_change: kisRow?.raw_ref?.kosdaq_change || null,
      usd_krw: kisRow?.raw_ref?.usd_krw || null,
      foreign_net_buy: kisRow?.raw_ref?.foreign_net_buy || null,
      institution_net_buy: kisRow?.raw_ref?.institution_net_buy || null,
      sectors: kisRow?.raw_ref?.sectors || [
        { name: '반도체', change: null },
        { name: '2차전지', change: null },
        { name: '바이오', change: null },
      ],
      events: kisRow?.raw_ref?.events || [],
    };
  } catch (err) {
    console.warn('[edu-x/kis] KIS 데이터 수집 실패:', err?.message);
    return {};
  }
}

async function fetchKisEvidenceItems() {
  try {
    if (!pgPool) return [];
    const result = await pgPool.query(`
      SELECT analyst, signal_direction, score, evidence_summary, raw_ref, symbol
      FROM investment.signals
      WHERE strategy_family = 'community_sentiment'
        AND market = 'domestic'
        AND created_at >= NOW() - INTERVAL '12 hours'
      ORDER BY (raw_ref->>'mentions')::int DESC NULLS LAST
      LIMIT 10
    `);
    return (result?.rows || []).map((r) => ({
      sourceName: r.analyst,
      signalDirection: r.signal_direction,
      evidenceSummary: r.evidence_summary,
      rawRef: r.raw_ref,
      symbol: r.symbol,
    }));
  } catch (err) {
    console.warn('[edu-x/kis] evidence 수집 실패:', err?.message);
    return [];
  }
}

// ─── 공용 유틸 ────────────────────────────────────────────────────

async function checkAlreadyPublished() {
  if (!pgPool) return false;
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const result = await pgPool.query(`
      SELECT id FROM edux_publish_log
      WHERE schedule_slot = $1 AND category = $2 AND status IN ('success', 'dry_run') AND created_at >= $3
      LIMIT 1
    `, [SLOT, CATEGORY, todayStart.toISOString()]);
    return (result?.rows || []).length > 0;
  } catch { return false; }
}

async function logPublish({ postId, postUrl, title, content, imageUrls, status, errorMsg, metadata }) {
  if (!pgPool) return;
  try {
    const contentHash = crypto.createHash('sha256').update(content || '').digest('hex').slice(0, 16);
    await pgPool.query(`
      INSERT INTO edux_publish_log (category, schedule_slot, post_id, post_url, title, content_hash, image_urls, status, error_msg, published_at, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    `, [CATEGORY, SLOT, postId || null, postUrl || null, title || null, contentHash,
        JSON.stringify(imageUrls || []), status, errorMsg || null,
        ['success', 'dry_run'].includes(status) ? new Date().toISOString() : null,
        JSON.stringify(metadata || {})]);
  } catch (err) {
    console.error('[edu-x/kis] 로그 저장 실패:', err?.message);
  }
}

async function sendTelegram(msg) {
  if (!telegramSender) return;
  try { await telegramSender.sendTelegramMessage(msg); } catch {}
}

// ─── 메인 ─────────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  const dryRunLabel = DRY_RUN ? '[DRY-RUN] ' : '';
  console.log(`[edu-x/kis] ${dryRunLabel}시작 — 슬롯: ${SLOT}`);

  const alreadyDone = await checkAlreadyPublished();
  if (alreadyDone) {
    console.log('[edu-x/kis] 오늘 이미 발행됨 → 스킵');
    return;
  }

  const [marketData, evidenceItems] = await Promise.allSettled([
    fetchKisMarketData(),
    fetchKisEvidenceItems(),
  ]).then((r) => [
    r[0].status === 'fulfilled' ? r[0].value : {},
    r[1].status === 'fulfilled' ? r[1].value : [],
  ]);

  const formatted = await formatPost(CATEGORY, SLOT, marketData, evidenceItems);
  if (!formatted?.content) {
    await logPublish({ status: 'fail', errorMsg: '본문 생성 실패', content: '', imageUrls: [] });
    await sendTelegram(`❌ [edu-x/kis] ${dryRunLabel}${SLOT} 본문 생성 실패`);
    return;
  }

  const { title, content } = formatted;
  console.log(`[edu-x/kis] 본문: ${content.length}자`);

  cleanupOldImages();
  const imagePaths = await generateKisImages({ marketData });

  if (DRY_RUN) {
    await logPublish({ title, content, imageUrls: imagePaths, status: 'dry_run', metadata: { evidenceCount: evidenceItems.length, contentLen: content.length } });
    console.log(`[edu-x/kis] ✅ DRY-RUN 완료`);
    await sendTelegram(`🔍 [edu-x/kis] Dry-run ${SLOT} — ${content.length}자, 이미지 ${imagePaths.length}장`);
    return;
  }

  const imageUrls = await uploadMultiple(imagePaths);
  const imageUrl = imageUrls[0] || null;
  let finalContent = content.replace(/\[이미지 플레이스홀더\]/, imageUrls.map((u) => `📸 ${u}`).join('\n'));

  const client = getEduxClient();
  const result = await client.post({ title, content: finalContent, imageUrl });
  if (!result?.id) {
    await logPublish({ title, content: finalContent, imageUrls, status: 'fail', errorMsg: 'API 발행 실패', metadata: { result } });
    await sendTelegram(`❌ [edu-x/kis] ${SLOT} 발행 실패`);
    return;
  }

  const postId = result.id;
  const postUrl = `https://edu-x.io/community/posts/${postId}`;
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  await logPublish({ postId, postUrl, title, content: finalContent, imageUrls, status: 'success', metadata: { elapsedSec: Number(elapsed) } });
  console.log(`[edu-x/kis] ✅ 발행 성공: ${postUrl} (${elapsed}s)`);
  await sendTelegram(`✅ [edu-x/kis] ${SLOT} 발행 완료!\n📝 ${title}\n🔗 ${postUrl}`);
}

main().catch((err) => {
  console.error('[edu-x/kis] 치명적 오류:', err);
  process.exit(1);
});
