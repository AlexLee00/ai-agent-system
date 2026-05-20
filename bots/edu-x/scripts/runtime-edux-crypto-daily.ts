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
 *   ② BTC 커뮤니티/뉴스 evidence 수집 (기본 72h)
 *   ③ Binance 가격 데이터
 *   ④ Hub LLM → 10섹션 본문 생성
 *   ⑤ 웹 렌더링용 HTML 블록 변환
 *   ⑥ POST /api/community/posts
 *   ⑦ edux_publish_log INSERT
 *   ⑧ Telegram 알림
 */

const path = require('path');
const env = require('../../../packages/core/lib/env');
const kst = require('../../../packages/core/lib/kst');

const { getEduxClient } = require('../lib/edux-client.ts');
const { formatPost } = require('../lib/edux-formatter.ts');
const { getFixturePayload } = require('../lib/edux-fixtures.ts');
const {
  parseArgs,
  resolveDryRun,
  dbQuery,
  ensurePublishLogTable,
  checkAlreadyPublished: checkAlreadyPublishedCommon,
  insertPublishLog,
  validatePostQuality,
  formatContentForEduXWeb,
  writeDryRunArtifact,
  assertLivePublishAllowed,
  emitJsonIfRequested,
  postUrlFor,
} = require('../lib/edux-runtime-support.ts');

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

const ARGS = parseArgs();
const DRY_RUN = resolveDryRun(ARGS);
const CATEGORY = 'crypto';
const COMMUNITY_LOOKBACK_HOURS = Math.max(8, Number(process.env.EDUX_CRYPTO_COMMUNITY_LOOKBACK_HOURS || 72));

function formatMarketSymbol(symbol) {
  const normalized = String(symbol || '').trim().toUpperCase();
  if (!normalized) return '';
  if (normalized.includes('/')) return normalized;
  if (normalized.endsWith('USDT')) return `${normalized.slice(0, -4)}/USDT`;
  if (normalized.endsWith('USD')) return `${normalized.slice(0, -3)}/USD`;
  return normalized;
}

function sanitizePublicEvidenceSummary(summary) {
  let text = String(summary || '').trim();
  if (!text) return text;
  text = text
    .replace(/\s*(avg_?upvote|upvotes?|totalScore|score|comments?|comment_count|like_count|likes?)\s*=\s*[^)\s,]+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+\)/g, ')')
    .trim();
  if (/^Reddit\s+r\/Bitcoin:\s*BTC\/USDT\s+mentions=/i.test(text)) {
    return 'Reddit r/Bitcoin에서 BTC/USDT 관련 토론이 관측됨';
  }
  return text;
}

function titleForPublish(title, liveGate) {
  return liveGate?.mode === 'one_off_live_test' ? `[TEST] ${title}` : title;
}

// ─── 슬롯 결정 ────────────────────────────────────────────────────

function detectSlot() {
  if (ARGS.slot && ['0600', '1400', '2230'].includes(ARGS.slot)) return ARGS.slot;
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

// ─── BTC 커뮤니티/뉴스 데이터 수집 ────────────────────────────────

function summarizeCommunityEvidence(row) {
  const articles = Array.isArray(row?.raw_ref?.articles) ? row.raw_ref.articles : [];
  const titles = articles
    .map((article) => article?.title)
    .filter(Boolean)
    .slice(0, 1);
  if (titles.length) return sanitizePublicEvidenceSummary(titles.join(' / '));
  return sanitizePublicEvidenceSummary(row?.evidence_summary || 'BTC 관련 커뮤니티 이슈가 감지되었습니다.');
}

async function fetchLunaEvidenceItems(hoursBack = 8) {
  if (ARGS.fixture) return getFixturePayload(CATEGORY).evidenceItems || [];
  try {
    if (!pgPool) return [];
    const cutoff = new Date(Date.now() - hoursBack * 3600 * 1000).toISOString();
    const result = await dbQuery(pgPool, `
      SELECT
        source_name,
        source_url,
        symbol,
        signal_direction,
        score,
        source_quality,
        freshness_score,
        evidence_summary,
        raw_ref,
        created_at
      FROM investment.external_evidence_events
      WHERE source_type = 'community'
        AND market = 'crypto'
        AND created_at >= $1
        AND COALESCE((raw_ref->>'missing_data')::boolean, false) = false
        AND (
          upper(coalesce(symbol, '')) IN ('BTC', 'BTCUSDT', 'BTC/USDT')
          OR evidence_summary ILIKE '%BTC%'
          OR evidence_summary ILIKE '%Bitcoin%'
          OR evidence_summary ILIKE '%비트코인%'
          OR raw_ref::text ILIKE '%BTC%'
          OR raw_ref::text ILIKE '%Bitcoin%'
          OR raw_ref::text ILIKE '%비트코인%'
        )
      ORDER BY
        CASE WHEN upper(coalesce(symbol, '')) IN ('BTC', 'BTCUSDT', 'BTC/USDT') THEN 0 ELSE 1 END,
        source_quality DESC NULLS LAST,
        ABS(score) DESC NULLS LAST,
        created_at DESC
      LIMIT 20
    `, [cutoff], 'public');
    return (result?.rows || []).map((r) => ({
      sourceName: r.source_name || 'btc-community',
      sourceUrl: r.source_url,
      signalDirection: r.signal_direction,
      score: r.score,
      sourceQuality: r.source_quality,
      freshnessScore: r.freshness_score,
      evidenceSummary: summarizeCommunityEvidence(r),
      rawRef: r.raw_ref || {},
      symbol: formatMarketSymbol(r.symbol),
      createdAt: r.created_at,
    }));
  } catch (err) {
    console.warn('[edu-x/crypto] BTC community evidence 조회 실패:', err?.message);
    return [];
  }
}

async function fetchBinancePrices() {
  if (ARGS.fixture) return getFixturePayload(CATEGORY).marketData || {};
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
    const [fearGreed, globalMarket] = await Promise.all([
      fetchFearGreedIndex(),
      fetchCoinGeckoGlobalMarket(),
    ]);

    const map = {};
    for (const t of data) {
      map[t.symbol] = {
        price: Number(t.lastPrice),
        change_24h: Number(t.priceChangePercent),
        volume: Number(t.volume),
      };
    }

    return {
      btc_symbol: 'BTC/USDT',
      btc_price: map['BTCUSDT']?.price,
      btc_change_24h: map['BTCUSDT']?.change_24h,
      eth_symbol: 'ETH/USDT',
      eth_price: map['ETHUSDT']?.price,
      eth_change_24h: map['ETHUSDT']?.change_24h,
      ...fearGreed,
      ...globalMarket,
      top_coins: [
        { symbol: 'BTC/USDT', price: map['BTCUSDT']?.price, change_24h: map['BTCUSDT']?.change_24h, market_cap: 1200 },
        { symbol: 'ETH/USDT', price: map['ETHUSDT']?.price, change_24h: map['ETHUSDT']?.change_24h, market_cap: 400 },
        { symbol: 'BNB/USDT', price: map['BNBUSDT']?.price, change_24h: map['BNBUSDT']?.change_24h, market_cap: 90 },
        { symbol: 'SOL/USDT', price: map['SOLUSDT']?.price, change_24h: map['SOLUSDT']?.change_24h, market_cap: 80 },
        { symbol: 'XRP/USDT', price: map['XRPUSDT']?.price, change_24h: map['XRPUSDT']?.change_24h, market_cap: 60 },
      ],
      altcoins: [
        { symbol: 'SOL/USDT', price: map['SOLUSDT']?.price, change_24h: map['SOLUSDT']?.change_24h, trigger: '모멘텀' },
        { symbol: 'XRP/USDT', price: map['XRPUSDT']?.price, change_24h: map['XRPUSDT']?.change_24h, trigger: 'ETF' },
      ],
    };
  } catch (err) {
    console.warn('[edu-x/crypto] Binance 가격 수집 실패:', err?.message);
    return {};
  }
}

async function fetchCoinGeckoGlobalMarket() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let payload;
    try {
      const resp = await fetch('https://api.coingecko.com/api/v3/global', {
        headers: { 'User-Agent': 'luna-edu-x-bot/1.0 (team-jay research)' },
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      payload = await resp.json();
    } finally {
      clearTimeout(timer);
    }

    const totalMarketCap = Number(payload?.data?.total_market_cap?.usd);
    if (!Number.isFinite(totalMarketCap) || totalMarketCap <= 0) return {};
    return {
      total_market_cap: totalMarketCap,
      total_market_cap_source: 'coingecko.global',
    };
  } catch (err) {
    console.warn('[edu-x/crypto] CoinGecko 글로벌 시총 수집 실패:', err?.message);
    return {};
  }
}

async function fetchFearGreedIndex() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let payload;
    try {
      const resp = await fetch('https://api.alternative.me/fng/?limit=1&format=json', {
        headers: { 'User-Agent': 'luna-edu-x-bot/1.0 (team-jay research)' },
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      payload = await resp.json();
    } finally {
      clearTimeout(timer);
    }

    const latest = payload?.data?.[0] || null;
    const value = latest?.value != null ? Number(latest.value) : null;
    if (!Number.isFinite(value)) return {};
    return {
      fear_greed_index: value,
      fear_greed_label: latest?.value_classification || null,
      fear_greed_source: 'alternative.me',
      fear_greed_timestamp: latest?.timestamp || null,
    };
  } catch (err) {
    console.warn('[edu-x/crypto] Fear & Greed 수집 실패:', err?.message);
    return {};
  }
}

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function roundNumber(value, decimals = 1) {
  const n = toFiniteNumber(value);
  if (n == null) return null;
  return Number(n.toFixed(decimals));
}

function formatUsdCompact(value) {
  const n = toFiniteNumber(value);
  if (n == null) return null;
  const abs = Math.abs(n);
  if (abs >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const slice = values.map(Number).filter(Number.isFinite);
  if (slice.length < period) return null;
  const multiplier = 2 / (period + 1);
  let current = slice.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  for (let i = period; i < slice.length; i += 1) {
    current = (slice[i] - current) * multiplier + current;
  }
  return current;
}

function computeRsi(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length <= period) return null;
  const recent = closes.slice(-(period + 1)).map(Number);
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < recent.length; i += 1) {
    const delta = recent[i] - recent[i - 1];
    if (delta >= 0) gains += delta;
    else losses += Math.abs(delta);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0 && avgGain === 0) return 50;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return roundNumber(100 - (100 / (1 + rs)), 1);
}

function computeMacd(closes) {
  if (!Array.isArray(closes) || closes.length < 35) return null;
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  if (ema12 == null || ema26 == null) return null;
  const macd = ema12 - ema26;
  const sign = macd >= 0 ? '+' : '';
  const label = macd >= 0 ? '상승 모멘텀' : '하락 모멘텀';
  return `${sign}${macd.toFixed(2)} (${label})`;
}

async function fetchCryptoTechnicalData() {
  if (ARGS.fixture) return getFixturePayload(CATEGORY).technicalData || {};
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let klines;
    try {
      const resp = await fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=100', {
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      klines = await resp.json();
    } finally {
      clearTimeout(timer);
    }

    const rows = Array.isArray(klines) ? klines : [];
    const closes = rows.map((r) => toFiniteNumber(r?.[4])).filter((v) => v != null);
    const recent48 = rows.slice(-48);
    const lows = recent48.map((r) => toFiniteNumber(r?.[3])).filter((v) => v != null);
    const highs = recent48.map((r) => toFiniteNumber(r?.[2])).filter((v) => v != null);
    const quoteVolume24h = rows
      .slice(-24)
      .map((r) => toFiniteNumber(r?.[7]))
      .filter((v) => v != null)
      .reduce((sum, v) => sum + v, 0);

    return {
      rsi: computeRsi(closes, 14),
      macd: computeMacd(closes),
      support: lows.length ? roundNumber(Math.min(...lows), 0) : null,
      resistance: highs.length ? roundNumber(Math.max(...highs), 0) : null,
      volume_24h: quoteVolume24h > 0 ? formatUsdCompact(quoteVolume24h) : null,
      source: 'binance.klines.BTCUSDT.1h',
    };
  } catch (err) {
    console.warn('[edu-x/crypto] BTC 기술지표 수집 실패:', err?.message);
    return {};
  }
}

// ─── 중복 발행 방지 ────────────────────────────────────────────────

async function checkAlreadyPublished(slot) {
  const result = await checkAlreadyPublishedCommon(pgPool, { category: CATEGORY, slot, dryRun: DRY_RUN });
  if (result.reason) console.warn('[edu-x/crypto] 중복 확인 경고:', result.reason);
  return result.already;
}

// ─── DB 로그 ──────────────────────────────────────────────────────

async function logPublish({ slot, postId, postUrl, title, content, imageUrls, status, errorMsg, metadata }) {
  const result = await insertPublishLog(pgPool, { category: CATEGORY, slot, postId, postUrl, title, content, imageUrls, status, errorMsg, metadata });
  if (result.ok) console.log(`[edu-x/crypto] 로그 저장: ${status} (슬롯: ${slot})`);
  else console.warn('[edu-x/crypto] 로그 저장 스킵/실패:', result.reason);
}

// ─── Telegram 알림 ────────────────────────────────────────────────

async function sendTelegram(msg) {
  if (!telegramSender || process.env.EDUX_DISABLE_TELEGRAM === 'true') return;
  try {
    if (typeof telegramSender.sendTelegramMessage === 'function') {
      await telegramSender.sendTelegramMessage(msg);
    } else if (typeof telegramSender.send === 'function') {
      await telegramSender.send('luna', msg);
    }
  } catch (err) {
    console.warn('[edu-x/crypto] telegram 실패:', err?.message);
  }
}

// ─── 메인 ─────────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  const slot = detectSlot();
  const dryRunLabel = DRY_RUN ? '[DRY-RUN] ' : '';
  const dbTable = await ensurePublishLogTable(pgPool);

  console.log(`[edu-x/crypto] ${dryRunLabel}시작 — 슬롯: ${slot}, fixture=${ARGS.fixture}, db=${dbTable.reason}`);

  if (!DRY_RUN && !dbTable.ok) {
    const liveGate = assertLivePublishAllowed({ tableOk: false, oneOffLiveTest: ARGS.oneOffLiveTest, fixture: ARGS.fixture });
    console.error('[edu-x/crypto] live 차단:', liveGate.reasons.join('; '));
    emitJsonIfRequested(ARGS.json, { ok: false, category: CATEGORY, slot, status: 'live_blocked', reasons: liveGate.reasons });
    return;
  }

  // 중복 방지
  const alreadyDone = await checkAlreadyPublished(slot);
  if (alreadyDone && !(ARGS.oneOffLiveTest && !DRY_RUN)) {
    console.log(`[edu-x/crypto] 오늘 ${slot} 슬롯 이미 발행됨 → 스킵`);
    emitJsonIfRequested(ARGS.json, { ok: true, category: CATEGORY, slot, status: 'skipped_already_published', dryRun: DRY_RUN });
    return;
  } else if (alreadyDone) {
    console.warn(`[edu-x/crypto] one-off live test — ${slot} 슬롯 중복 발행 확인을 우회합니다.`);
  }

  // ① 데이터 수집
  const [evidenceItems, marketData, technicalData] = await Promise.allSettled([
    fetchLunaEvidenceItems(COMMUNITY_LOOKBACK_HOURS),
    fetchBinancePrices(),
    fetchCryptoTechnicalData(),
  ]).then((results) => [
    results[0].status === 'fulfilled' ? results[0].value : [],
    results[1].status === 'fulfilled' ? results[1].value : {},
    results[2].status === 'fulfilled' ? results[2].value : {},
  ]);

  console.log(`[edu-x/crypto] 데이터 수집 완료: evidence ${evidenceItems.length}건`);

  // ② 본문 생성
  const formatted = await formatPost(CATEGORY, slot, marketData, evidenceItems, technicalData, { fixture: ARGS.fixture });
  if (!formatted?.content) {
    const errMsg = '본문 생성 실패';
    console.error(`[edu-x/crypto] ${errMsg}`);
    await logPublish({ slot, status: 'fail', errorMsg: errMsg, content: '', imageUrls: [] });
    await sendTelegram(`❌ [edu-x/crypto] ${dryRunLabel}${slot} 슬롯 ${errMsg}`);
    return;
  }

  const { title, content } = formatted;
  console.log(`[edu-x/crypto] 본문 생성: ${content.length}자 (제목: ${title}, source=${formatted.source || 'hub_llm'})`);

  // ③ 이미지 첨부는 운영 피드백에 따라 비활성화한다.
  const imagePaths = [];
  console.log('[edu-x/crypto] 이미지 생성/업로드 비활성화 — 본문 텍스트만 게시');

  const quality = validatePostQuality({ content, imagePaths });
  if (!quality.ok) {
    const errMsg = `품질 게이트 미달: ${JSON.stringify(quality)}`;
    console.error(`[edu-x/crypto] ${errMsg}`);
    await logPublish({ slot, title, content, imageUrls: [], status: 'fail', errorMsg: errMsg, metadata: { quality, formatterSource: formatted.source, imageAttachmentDisabled: true } });
    emitJsonIfRequested(ARGS.json, { ok: false, category: CATEGORY, slot, status: 'quality_failed', quality });
    return;
  }

  // ④ Dry-run 처리
  if (DRY_RUN) {
    const artifact = writeDryRunArtifact({
      category: CATEGORY,
      slot,
      title,
      content,
      imagePaths,
      metadata: { evidenceCount: evidenceItems.length, quality, formatterSource: formatted.source, fixture: ARGS.fixture, imageAttachmentDisabled: true },
    });
    await logPublish({
      slot,
      title,
      content,
      imageUrls: [],
      status: 'dry_run',
      metadata: { evidenceCount: evidenceItems.length, quality, formatterSource: formatted.source, fixture: ARGS.fixture, artifact, imageAttachmentDisabled: true },
    });
    console.log(`[edu-x/crypto] ✅ DRY-RUN 완료 — 실 발행 없음 (${slot})`);
    await sendTelegram(`🔍 [edu-x/crypto] Dry-run ${slot} — ${content.length}자, 이미지 첨부 없음`);
    emitJsonIfRequested(ARGS.json, { ok: true, category: CATEGORY, slot, status: 'dry_run', quality, artifact, imagePaths });
    return;
  }

  const liveGate = assertLivePublishAllowed({ tableOk: dbTable.ok, oneOffLiveTest: ARGS.oneOffLiveTest, fixture: ARGS.fixture });
  if (!liveGate.ok) {
    const errMsg = `live_publish_blocked: ${liveGate.reasons.join('; ')}`;
    await logPublish({ slot, title, content, imageUrls: [], status: 'skipped', errorMsg: errMsg, metadata: { liveGate, quality, imageAttachmentDisabled: true } });
    console.error(`[edu-x/crypto] ${errMsg}`);
    emitJsonIfRequested(ARGS.json, { ok: false, category: CATEGORY, slot, status: 'live_blocked', reasons: liveGate.reasons });
    return;
  }

  const imageUrls = [];
  const finalContent = formatContentForEduXWeb(content);
  const publishTitle = titleForPublish(title, liveGate);

  // ⑥ 실 발행
  const client = getEduxClient();
  const result = await client.post({ title: publishTitle, content: finalContent });

  if (!result?.id) {
    const errMsg = '발행 실패 (API 오류)';
    console.error(`[edu-x/crypto] ${errMsg}:`, JSON.stringify(result));
    await logPublish({ slot, title: publishTitle, content: finalContent, imageUrls, status: 'fail', errorMsg: errMsg, metadata: { result, liveGate, imageAttachmentDisabled: true, contentFormat: 'html_blocks' } });
    await sendTelegram(`❌ [edu-x/crypto] ${slot} ${errMsg}`);
    return;
  }

  const postId = result.id;
  const postUrl = postUrlFor(client.getBaseUrl ? client.getBaseUrl() : 'https://edu-x.io', postId);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  await logPublish({
    slot, postId, postUrl, title: publishTitle,
    content: finalContent, imageUrls,
    status: 'success',
    metadata: {
      evidenceCount: evidenceItems.length,
      contentLen: finalContent.length,
      elapsedSec: Number(elapsed),
      liveGate,
      imageAttachmentDisabled: true,
      contentFormat: 'html_blocks',
    },
  });

  console.log(`[edu-x/crypto] ✅ 발행 성공: ${postUrl} (${elapsed}s)`);
  await sendTelegram(`✅ [edu-x/crypto] ${slot} 발행 완료!\n📝 ${publishTitle}\n🔗 ${postUrl}\n📊 ${finalContent.length}자`);
  emitJsonIfRequested(ARGS.json, { ok: true, category: CATEGORY, slot, status: 'success', postId, postUrl, quality });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[edu-x/crypto] 치명적 오류:', err);
    process.exit(1);
  });
}

module.exports = {
  main,
  detectSlot,
  fetchLunaEvidenceItems,
  fetchBinancePrices,
  fetchFearGreedIndex,
  fetchCoinGeckoGlobalMarket,
  fetchCryptoTechnicalData,
  computeRsi,
  computeMacd,
  formatMarketSymbol,
  sanitizePublicEvidenceSummary,
};
