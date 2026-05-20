#!/usr/bin/env node
// @ts-nocheck
'use strict';

/**
 * runtime-edux-crypto-daily.ts — 암호화폐 일일 브리핑 발행
 *
 * 슬롯: 06:00 / 14:00 / 22:30 KST (launchd 자동 실행)
 * Dry-run: EDUX_DRY_RUN=true (기본값) → 실 발행 없이 DB 저장만
 *
 * 흐름:
 *   ① 슬롯 확인
 *   ② 루나팀 community_evidence 수집 (8h)
 *   ③ Binance 가격 데이터
 *   ④ Hub LLM → 10섹션 본문 생성
 *   ⑤ 이미지 2장 생성
 *   ⑥ 이미지 업로드 (Edu-X)
 *   ⑦ POST /api/community/posts
 *   ⑧ edux_publish_log INSERT
 *   ⑨ Telegram 알림
 */

const path = require('path');
const crypto = require('crypto');
const env = require('../../../packages/core/lib/env');
const kst = require('../../../packages/core/lib/kst');
const { queryOpsDb } = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/hub-client'));

const { getEduxClient } = require('../lib/edux-client');
const { uploadMultiple } = require('../lib/edux-image-uploader');
const { formatPost } = require('../lib/edux-formatter');
const { generateCryptoImages, cleanupOldImages } = require('../lib/edux-image-generator');

// Telegram
let telegramSender;
try {
  telegramSender = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/telegram-sender'));
} catch {
  telegramSender = null;
}

// PostgreSQL
let pgPool;
try {
  pgPool = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/pg-pool'));
} catch {
  pgPool = null;
}

const DRY_RUN = process.env.EDUX_DRY_RUN !== 'false';
const CATEGORY = 'crypto';

// ─── 슬롯 결정 ────────────────────────────────────────────────────

function detectSlot() {
  const forcedSlot = process.env.EDUX_FORCE_SLOT;
  if (forcedSlot && ['0600', '1400', '2230'].includes(forcedSlot)) {
    return forcedSlot;
  }
  const now = kst.now ? kst.now() : new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  const total = h * 60 + m;

  // 30분 윈도우로 슬롯 감지
  if (total >= 350 && total < 410) return '0600'; // 05:50~06:50
  if (total >= 810 && total < 870) return '1400'; // 13:50~14:50
  if (total >= 1330 && total < 1390) return '2230'; // 22:10~23:10

  // 직접 실행 시 가장 가까운 슬롯
  console.warn(`[edu-x/crypto] 슬롯 감지 실패 (${h}:${String(m).padStart(2, '0')}) → 1400 기본값`);
  return '1400';
}

// ─── 루나팀 데이터 수집 ────────────────────────────────────────────

async function fetchLunaEvidenceItems(hoursBack = 8) {
  try {
    if (!pgPool) return [];
    const cutoff = new Date(Date.now() - hoursBack * 3600 * 1000).toISOString();
    const result = await pgPool.query(`
      SELECT
        analyst,
        signal_direction,
        score,
        source_quality,
        evidence_summary,
        raw_ref,
        created_at,
        symbol
      FROM investment.signals
      WHERE strategy_family = 'community_sentiment'
        AND market = 'crypto'
        AND created_at >= $1
      ORDER BY (raw_ref->>'mentions')::int DESC NULLS LAST, created_at DESC
      LIMIT 20
    `, [cutoff]);
    return (result?.rows || []).map((r) => ({
      sourceName: r.analyst,
      signalDirection: r.signal_direction,
      score: r.score,
      evidenceSummary: r.evidence_summary,
      rawRef: r.raw_ref,
      symbol: r.symbol,
      createdAt: r.created_at,
    }));
  } catch (err) {
    console.warn('[edu-x/crypto] luna evidence 조회 실패:', err?.message);
    return [];
  }
}

async function fetchBinancePrices() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let data;
    try {
      const resp = await fetch('https://api.binance.com/api/v3/ticker/24hr?symbols=["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","BNBUSDT"]', {
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      data = await resp.json();
    } finally {
      clearTimeout(timer);
    }

    const map = {};
    for (const t of data) {
      map[t.symbol] = {
        price: Number(t.lastPrice),
        change_24h: Number(t.priceChangePercent),
        volume: Number(t.volume),
      };
    }

    return {
      btc_price: map['BTCUSDT']?.price,
      btc_change_24h: map['BTCUSDT']?.change_24h,
      eth_price: map['ETHUSDT']?.price,
      eth_change_24h: map['ETHUSDT']?.change_24h,
      top_coins: [
        { symbol: 'BTC', price: map['BTCUSDT']?.price, change_24h: map['BTCUSDT']?.change_24h, market_cap: 1200 },
        { symbol: 'ETH', price: map['ETHUSDT']?.price, change_24h: map['ETHUSDT']?.change_24h, market_cap: 400 },
        { symbol: 'BNB', price: map['BNBUSDT']?.price, change_24h: map['BNBUSDT']?.change_24h, market_cap: 90 },
        { symbol: 'SOL', price: map['SOLUSDT']?.price, change_24h: map['SOLUSDT']?.change_24h, market_cap: 80 },
        { symbol: 'XRP', price: map['XRPUSDT']?.price, change_24h: map['XRPUSDT']?.change_24h, market_cap: 60 },
      ],
      altcoins: [
        { symbol: 'SOL', price: map['SOLUSDT']?.price, change_24h: map['SOLUSDT']?.change_24h, trigger: '모멘텀' },
        { symbol: 'XRP', price: map['XRPUSDT']?.price, change_24h: map['XRPUSDT']?.change_24h, trigger: 'ETF' },
      ],
    };
  } catch (err) {
    console.warn('[edu-x/crypto] Binance 가격 수집 실패:', err?.message);
    return {};
  }
}

// ─── 중복 발행 방지 ────────────────────────────────────────────────

async function checkAlreadyPublished(slot) {
  if (!pgPool) return false;
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const result = await pgPool.query(`
      SELECT id FROM edux_publish_log
      WHERE schedule_slot = $1
        AND category = $2
        AND status IN ('success', 'dry_run')
        AND created_at >= $3
      LIMIT 1
    `, [slot, CATEGORY, todayStart.toISOString()]);
    return (result?.rows || []).length > 0;
  } catch (err) {
    console.warn('[edu-x/crypto] 중복 확인 실패:', err?.message);
    return false;
  }
}

// ─── DB 로그 ──────────────────────────────────────────────────────

async function logPublish({ slot, postId, postUrl, title, content, imageUrls, status, errorMsg, metadata }) {
  if (!pgPool) return;
  try {
    const contentHash = crypto.createHash('sha256').update(content || '').digest('hex').slice(0, 16);
    await pgPool.query(`
      INSERT INTO edux_publish_log
        (category, schedule_slot, post_id, post_url, title, content_hash, image_urls, status, error_msg, published_at, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [
      CATEGORY,
      slot,
      postId || null,
      postUrl || null,
      title || null,
      contentHash,
      JSON.stringify(imageUrls || []),
      status,
      errorMsg || null,
      status === 'success' || status === 'dry_run' ? new Date().toISOString() : null,
      JSON.stringify(metadata || {}),
    ]);
    console.log(`[edu-x/crypto] 로그 저장: ${status} (슬롯: ${slot})`);
  } catch (err) {
    console.error('[edu-x/crypto] 로그 저장 실패:', err?.message);
  }
}

// ─── Telegram 알림 ────────────────────────────────────────────────

async function sendTelegram(msg) {
  if (!telegramSender) return;
  try {
    await telegramSender.sendTelegramMessage(msg);
  } catch (err) {
    console.warn('[edu-x/crypto] telegram 실패:', err?.message);
  }
}

// ─── 메인 ─────────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  const slot = detectSlot();
  const dryRunLabel = DRY_RUN ? '[DRY-RUN] ' : '';

  console.log(`[edu-x/crypto] ${dryRunLabel}시작 — 슬롯: ${slot}`);

  // 중복 방지
  const alreadyDone = await checkAlreadyPublished(slot);
  if (alreadyDone) {
    console.log(`[edu-x/crypto] 오늘 ${slot} 슬롯 이미 발행됨 → 스킵`);
    return;
  }

  // ① 데이터 수집
  const [evidenceItems, marketData] = await Promise.allSettled([
    fetchLunaEvidenceItems(8),
    fetchBinancePrices(),
  ]).then((results) => [
    results[0].status === 'fulfilled' ? results[0].value : [],
    results[1].status === 'fulfilled' ? results[1].value : {},
  ]);

  console.log(`[edu-x/crypto] 데이터 수집 완료: evidence ${evidenceItems.length}건`);

  // ② 본문 생성
  const formatted = await formatPost(CATEGORY, slot, marketData, evidenceItems);
  if (!formatted?.content) {
    const errMsg = '본문 생성 실패';
    console.error(`[edu-x/crypto] ${errMsg}`);
    await logPublish({ slot, status: 'fail', errorMsg: errMsg, content: '', imageUrls: [] });
    await sendTelegram(`❌ [edu-x/crypto] ${dryRunLabel}${slot} 슬롯 ${errMsg}`);
    return;
  }

  const { title, content } = formatted;
  console.log(`[edu-x/crypto] 본문 생성: ${content.length}자 (제목: ${title})`);

  // ③ 이미지 생성
  cleanupOldImages();
  const imagePaths = await generateCryptoImages(slot, { marketData });
  console.log(`[edu-x/crypto] 이미지 ${imagePaths.length}장 생성`);

  // ④ Dry-run 처리
  if (DRY_RUN) {
    await logPublish({
      slot,
      title,
      content,
      imageUrls: imagePaths,
      status: 'dry_run',
      metadata: { evidenceCount: evidenceItems.length, contentLen: content.length, dryRun: true },
    });
    console.log(`[edu-x/crypto] ✅ DRY-RUN 완료 — 실 발행 없음 (${slot})`);
    await sendTelegram(`🔍 [edu-x/crypto] Dry-run ${slot} — ${content.length}자, 이미지 ${imagePaths.length}장`);
    return;
  }

  // ⑤ 이미지 업로드
  const imageUrls = await uploadMultiple(imagePaths);
  const imageUrl = imageUrls[0] || null;
  console.log(`[edu-x/crypto] 이미지 업로드 완료: ${imageUrls.length}개 URL`);

  // 본문에 이미지 URL 삽입 (플레이스홀더 치환)
  let finalContent = content;
  if (imageUrls.length > 0) {
    finalContent = content.replace(
      /\[이미지 2장 플레이스홀더 — 실제 URL은 후처리\]/,
      imageUrls.map((u) => `📸 ${u}`).join('\n')
    );
  }

  // ⑥ 실 발행
  const client = getEduxClient();
  const result = await client.post({ title, content: finalContent, imageUrl });

  if (!result?.id) {
    const errMsg = '발행 실패 (API 오류)';
    console.error(`[edu-x/crypto] ${errMsg}:`, JSON.stringify(result));
    await logPublish({ slot, title, content: finalContent, imageUrls, status: 'fail', errorMsg: errMsg, metadata: { result } });
    await sendTelegram(`❌ [edu-x/crypto] ${slot} ${errMsg}`);
    return;
  }

  const postId = result.id;
  const postUrl = `https://edu-x.io/community/posts/${postId}`;
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  await logPublish({
    slot, postId, postUrl, title,
    content: finalContent, imageUrls,
    status: 'success',
    metadata: {
      evidenceCount: evidenceItems.length,
      contentLen: finalContent.length,
      elapsedSec: Number(elapsed),
    },
  });

  console.log(`[edu-x/crypto] ✅ 발행 성공: ${postUrl} (${elapsed}s)`);
  await sendTelegram(`✅ [edu-x/crypto] ${slot} 발행 완료!\n📝 ${title}\n🔗 ${postUrl}\n📊 ${finalContent.length}자`);
}

main().catch((err) => {
  console.error('[edu-x/crypto] 치명적 오류:', err);
  process.exit(1);
});
