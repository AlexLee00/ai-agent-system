#!/usr/bin/env node
// @ts-nocheck
'use strict';

/**
 * runtime-edux-overseas-daily.ts — 해외주식 일일 브리핑 발행
 *
 * 슬롯: 22:00 KST (NY 개장 30분 전)
 * Dry-run: EDUX_DRY_RUN=true (기본)
 */

const path = require('path');
const env = require('../../../packages/core/lib/env');

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
  shouldSendPublishSuccessTelegram,
  emitJsonIfRequested,
  postUrlFor,
} = require('../lib/edux-runtime-support.ts');

let telegramSender;
try {
  telegramSender = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/telegram-sender'));
} catch { telegramSender = null; }

let pgPool;
try {
  pgPool = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/pg-pool'));
} catch { pgPool = null; }

const ARGS = parseArgs();
const DRY_RUN = resolveDryRun(ARGS);
const CATEGORY = 'overseas';
const ALLOWED_SLOTS = new Set(['2200', '0630']);
const DEFAULT_SLOT = '2200';

let marketHoursGuard = null;
try {
  marketHoursGuard = require(path.join(env.PROJECT_ROOT, 'bots/investment/shared/kis-market-hours-guard.ts'));
} catch { marketHoursGuard = null; }

function titleForPublish(title, liveGate) {
  return liveGate?.mode === 'one_off_live_test' ? `[TEST] ${title}` : title;
}

function runtimeNow() {
  const forced = process.env.EDUX_TEST_NOW;
  if (forced) {
    const date = new Date(forced);
    if (Number.isFinite(date.getTime())) return date;
  }
  return new Date();
}

function timeZoneParts(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return {
    weekday: parts.weekday,
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    minutesOfDay: Number(parts.hour === '24' ? 0 : parts.hour) * 60 + Number(parts.minute || 0),
  };
}

function fallbackEvaluateOverseasMarketHours({ now = runtimeNow() } = {}) {
  const nyParts = timeZoneParts(now, 'America/New_York');
  const weekend = ['Sat', 'Sun'].includes(nyParts.weekday || '');
  const holidays = new Set([
    '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03',
    '2026-05-25', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  ]);
  const holiday = holidays.has(nyParts.dateStr);
  const isOpen = !weekend && !holiday && nyParts.minutesOfDay >= 9 * 60 + 30 && nyParts.minutesOfDay < 16 * 60;
  return {
    market: 'overseas',
    isOpen,
    state: isOpen ? 'open' : 'closed',
    reasonCode: holiday ? 'holiday' : isOpen ? 'kis_market_open' : 'kis_market_closed',
    marketDateStr: nyParts.dateStr,
    marketTimezone: 'America/New_York',
    weekday: nyParts.weekday,
  };
}

function evaluateOverseasMarketHours(now = runtimeNow()) {
  if (typeof marketHoursGuard?.evaluateKisMarketHours === 'function') {
    try {
      return marketHoursGuard.evaluateKisMarketHours({ market: 'overseas', now });
    } catch {}
  }
  return fallbackEvaluateOverseasMarketHours({ now });
}

function detectSlot() {
  const requested = ARGS.slot || process.env.EDUX_FORCE_SLOT;
  if (requested) {
    if (ALLOWED_SLOTS.has(String(requested))) return { ok: true, slot: String(requested), source: 'explicit' };
    return { ok: false, requested: String(requested), allowed: Array.from(ALLOWED_SLOTS) };
  }
  const now = runtimeNow();
  const kstParts = timeZoneParts(now, 'Asia/Seoul');
  const total = kstParts.minutesOfDay;
  if (total >= 370 && total < 430) return { ok: true, slot: '0630', source: 'time_window' };
  if (total >= 1300 && total < 1360) return { ok: true, slot: '2200', source: 'time_window' };
  return { ok: true, slot: DEFAULT_SLOT, source: 'default' };
}

function shouldSkipMarketDay(slot, now = runtimeNow()) {
  const market = evaluateOverseasMarketHours(now);
  const nyParts = timeZoneParts(now, 'America/New_York');
  // Overseas slots follow the New York market date, not the KST calendar date.
  // KST Saturday 06:30 is Friday's NY close and should publish; KST Monday
  // 06:30 is Sunday in New York and should skip.
  const weekend = ['Sat', 'Sun'].includes(nyParts.weekday || '');
  const holiday = market.reasonCode === 'holiday';
  return {
    skip: weekend || holiday,
    reason: holiday ? 'holiday' : weekend ? 'weekend' : null,
    market,
    marketDate: nyParts.dateStr,
  };
}

// ─── 해외주식 데이터 수집 ─────────────────────────────────────────

function latestTwoNumeric(values = []) {
  const numeric = values.filter((value) => value != null && Number.isFinite(Number(value)) && Number(value) !== 0).map(Number).slice(-2);
  if (numeric.length === 1) return [null, numeric[0]];
  return numeric;
}

async function fetchYahooChart(symbol) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`, {
      headers: { 'User-Agent': 'luna-edu-x-bot/1.0 (team-jay research)' },
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    const closes = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
    const [prev, latest] = latestTwoNumeric(closes);
    if (!Number.isFinite(Number(latest))) return null;
    const change = Number.isFinite(Number(prev)) && Number(prev) !== 0
      ? ((Number(latest) - Number(prev)) / Number(prev)) * 100
      : null;
    return { latest: Number(latest), change };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchYahooSymbols(symbols) {
  const entries = await Promise.allSettled(symbols.map(async (symbol) => [symbol, await fetchYahooChart(symbol)]));
  return Object.fromEntries(entries
    .filter((entry) => entry.status === 'fulfilled')
    .map((entry) => entry.value)
    .filter(([, value]) => value));
}

async function fetchOverseasMarketData() {
  if (ARGS.fixture) return getFixturePayload(CATEGORY).marketData || {};
  try {
    const quoteMap = await fetchYahooSymbols([
      '^GSPC', '^IXIC', '^DJI', '^VIX', '^TNX', 'DX-Y.NYB',
      'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA',
      'QQQ', 'XLK', 'XLE',
    ]);
    const mag7Symbols = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA'];
    const etfSymbols = ['QQQ', 'XLK', 'XLE'];

    return {
      sp500_index: quoteMap['^GSPC']?.latest ? Math.round(quoteMap['^GSPC'].latest) : null,
      sp500_change: quoteMap['^GSPC']?.change ?? null,
      nasdaq_index: quoteMap['^IXIC']?.latest ? Math.round(quoteMap['^IXIC'].latest) : null,
      nasdaq_change: quoteMap['^IXIC']?.change ?? null,
      dow_index: quoteMap['^DJI']?.latest ? Math.round(quoteMap['^DJI'].latest) : null,
      dow_change: quoteMap['^DJI']?.change ?? null,
      dxy: quoteMap['DX-Y.NYB']?.latest ? Number(quoteMap['DX-Y.NYB'].latest.toFixed(2)) : null,
      vix: quoteMap['^VIX']?.latest ? Number(quoteMap['^VIX'].latest.toFixed(2)) : null,
      us10y: quoteMap['^TNX']?.latest ? Number((quoteMap['^TNX'].latest / 10).toFixed(2)) : null,
      mag7: mag7Symbols.map((symbol) => ({
        symbol,
        price: quoteMap[symbol]?.latest ?? null,
        change_1d: quoteMap[symbol]?.change ?? null,
      })),
      earnings: [],
      top_etfs: etfSymbols.map((symbol) => ({
        symbol,
        price: quoteMap[symbol]?.latest ?? null,
        change_1d: quoteMap[symbol]?.change ?? null,
      })),
    };
  } catch (err) {
    console.warn('[edu-x/overseas] 시장 데이터 수집 실패:', err?.message);
    return {};
  }
}

async function fetchOverseasEvidenceItems() {
  if (ARGS.fixture) return getFixturePayload(CATEGORY).evidenceItems || [];
  try {
    if (!pgPool) return [];
    const result = await dbQuery(pgPool, `
      SELECT symbol, action, confidence, reasoning, analyst_signals, block_meta, strategy_family
      FROM investment.signals
      WHERE exchange = 'kis_overseas'
        AND created_at >= NOW() - INTERVAL '12 hours'
      ORDER BY confidence DESC NULLS LAST, created_at DESC
      LIMIT 10
    `, [], 'public');
    return (result?.rows || []).map((r) => ({
      sourceName: r.strategy_family || r.analyst_signals || 'luna-overseas-signal',
      signalDirection: r.action,
      evidenceSummary: r.reasoning,
      rawRef: { ...(r.block_meta || {}), mentions: Math.round(Number(r.confidence || 0) * 100) },
      symbol: r.symbol,
    }));
  } catch (err) {
    console.warn('[edu-x/overseas] evidence 수집 실패:', err?.message);
    return [];
  }
}

function buildOverseasWatchPoints(marketData = {}, evidenceItems = []) {
  const mag7 = Array.isArray(marketData.mag7) ? marketData.mag7 : [];
  const strongest = mag7
    .filter((item) => item && item.change_1d != null)
    .slice()
    .sort((a, b) => Number(b.change_1d ?? 0) - Number(a.change_1d ?? 0))[0];
  const issue = (evidenceItems || []).find((item) => item?.evidenceSummary)?.evidenceSummary;
  return [
    strongest ? `${strongest.symbol} 중심 Mag7 동조 여부` : 'Mag7 동조와 Nasdaq 상대 강도 확인',
    marketData.us10y != null || marketData.dxy != null ? '미 10년물/DXY 안정 여부' : '금리·달러 흐름 확인',
    issue ? String(issue).slice(0, 90) : '한국 반도체·성장주로 이어질 수급 온도 확인',
  ].filter(Boolean);
}

function parseWatchPoints(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  if (!value) return [];
  if (typeof value === 'string') {
    try { return parseWatchPoints(JSON.parse(value)); } catch { return [value]; }
  }
  return [];
}

async function fetchPreviousWatchPoints(prevSlot) {
  if (ARGS.fixture) return getFixturePayload(CATEGORY).previousWatchPoints || [];
  if (!pgPool) return [];
  try {
    const result = await dbQuery(pgPool, `
      SELECT metadata->'watchPoints' AS watch_points
      FROM edux_publish_log
      WHERE category = $1
        AND schedule_slot = $2
        AND status IN ('dry_run', 'success')
        AND created_at >= NOW() - INTERVAL '24 hours'
        AND metadata ? 'watchPoints'
      ORDER BY created_at DESC
      LIMIT 1
    `, [CATEGORY, prevSlot], 'public');
    return parseWatchPoints(result?.rows?.[0]?.watch_points);
  } catch (err) {
    console.warn('[edu-x/overseas] 이전 watchPoints 조회 실패:', err?.message);
    return [];
  }
}

// ─── 공용 유틸 ────────────────────────────────────────────────────

async function checkAlreadyPublished(slot) {
  const result = await checkAlreadyPublishedCommon(pgPool, { category: CATEGORY, slot, dryRun: DRY_RUN });
  return result.already;
}

async function logPublish({ slot, postId, postUrl, title, content, imageUrls, status, errorMsg, metadata }) {
  const testPost = ARGS.testPost === true || ARGS.oneOffLiveTest === true;
  const result = await insertPublishLog(pgPool, {
    category: CATEGORY,
    slot,
    postId,
    postUrl,
    title,
    content,
    imageUrls,
    status,
    errorMsg,
    metadata: {
      ...(metadata || {}),
      testPost,
      oneOffLiveTest: ARGS.oneOffLiveTest === true,
      excludeFromLunaEvidence: ARGS.excludeFromLunaEvidence === true || testPost,
    },
  });
  if (!result.ok) console.warn('[edu-x/overseas] 로그 저장 스킵/실패:', result.reason);
}

async function sendTelegram(msg) {
  if (!telegramSender || process.env.EDUX_DISABLE_TELEGRAM === 'true') return;
  try {
    if (typeof telegramSender.sendTelegramMessage === 'function') await telegramSender.sendTelegramMessage(msg);
    else if (typeof telegramSender.send === 'function') await telegramSender.send('luna', msg);
  } catch {}
}

// ─── 메인 ─────────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  const slotResult = detectSlot();
  if (!slotResult.ok) {
    console.error(`[edu-x/overseas] invalid_slot: ${slotResult.requested}`);
    emitJsonIfRequested(ARGS.json, { ok: false, category: CATEGORY, slot: slotResult.requested, status: 'invalid_slot', allowed: slotResult.allowed });
    process.exitCode = 1;
    return;
  }
  const slot = slotResult.slot;
  const dryRunLabel = DRY_RUN ? '[DRY-RUN] ' : '';
  const dbTable = await ensurePublishLogTable(pgPool);
  console.log(`[edu-x/overseas] ${dryRunLabel}시작 — 슬롯: ${slot}, fixture=${ARGS.fixture}, db=${dbTable.reason}`);

  if (!DRY_RUN && !dbTable.ok) {
    const liveGate = assertLivePublishAllowed({ tableOk: false, oneOffLiveTest: ARGS.oneOffLiveTest, fixture: ARGS.fixture });
    console.error('[edu-x/overseas] live 차단:', liveGate.reasons.join('; '));
    emitJsonIfRequested(ARGS.json, { ok: false, category: CATEGORY, slot, status: 'live_blocked', reasons: liveGate.reasons });
    return;
  }

  const holidaySkip = shouldSkipMarketDay(slot);
  if (holidaySkip.skip) {
    const metadata = { marketCalendar: holidaySkip, skipStatus: 'skipped_holiday', fixture: ARGS.fixture, imageAttachmentDisabled: true };
    await logPublish({ slot, title: null, content: '', imageUrls: [], status: 'skipped', errorMsg: holidaySkip.reason, metadata });
    console.log(`[edu-x/overseas] ${slot} 시장 휴장/주말 스킵: ${holidaySkip.reason}`);
    emitJsonIfRequested(ARGS.json, { ok: true, category: CATEGORY, slot, status: 'skipped_holiday', reason: holidaySkip.reason, marketCalendar: holidaySkip });
    return;
  }

  const alreadyDone = await checkAlreadyPublished(slot);
  if (alreadyDone && !(ARGS.oneOffLiveTest && !DRY_RUN)) {
    console.log('[edu-x/overseas] 오늘 이미 발행됨 → 스킵');
    emitJsonIfRequested(ARGS.json, { ok: true, category: CATEGORY, slot, status: 'skipped_already_published', dryRun: DRY_RUN });
    return;
  } else if (alreadyDone) {
    console.warn('[edu-x/overseas] one-off live test — 슬롯 중복 발행 확인을 우회합니다.');
  }

  const [marketData, evidenceItems] = await Promise.allSettled([
    fetchOverseasMarketData(),
    fetchOverseasEvidenceItems(),
  ]).then((r) => [
    r[0].status === 'fulfilled' ? r[0].value : {},
    r[1].status === 'fulfilled' ? r[1].value : [],
  ]);
  const previousWatchPoints = slot === '0630' ? await fetchPreviousWatchPoints('2200') : [];
  const watchPoints = slot === '2200' ? buildOverseasWatchPoints(marketData, evidenceItems) : [];
  const formatContext = slot === '0630' ? { previousWatchPoints } : {};

  const formatted = await formatPost(CATEGORY, slot, marketData, evidenceItems, formatContext, { fixture: ARGS.fixture });
  if (!formatted?.content) {
    await logPublish({ slot, status: 'fail', errorMsg: '본문 생성 실패', content: '', imageUrls: [] });
    await sendTelegram(`❌ [edu-x/overseas] ${dryRunLabel}${slot} 본문 생성 실패`);
    return;
  }

  const { title, content } = formatted;
  const formatterMetadata = {
    formatterSource: formatted.source,
    formatterMode: formatted.formatterMode,
    formatterLlm: formatted.llm || null,
  };
  console.log(`[edu-x/overseas] 본문: ${content.length}자`);

  const imagePaths = [];
  console.log('[edu-x/overseas] 이미지 생성/업로드 비활성화 — 본문 텍스트만 게시');
  const quality = validatePostQuality({ content, imagePaths, category: CATEGORY, slot });
  const slotMetadata = {
    ...(watchPoints.length ? { watchPoints, watchPointsSource: 'runtime_overseas_2200' } : {}),
    ...(previousWatchPoints.length ? { previousWatchPoints, reviewSourceSlot: '2200' } : {}),
  };
  if (!quality.ok) {
    const errMsg = `품질 게이트 미달: ${JSON.stringify(quality)}`;
    await logPublish({ slot, title, content, imageUrls: [], status: 'fail', errorMsg: errMsg, metadata: { quality, ...formatterMetadata, ...slotMetadata, imageAttachmentDisabled: true } });
    console.error(`[edu-x/overseas] ${errMsg}`);
    emitJsonIfRequested(ARGS.json, { ok: false, category: CATEGORY, slot, status: 'quality_failed', quality });
    return;
  }

  if (DRY_RUN) {
    const artifact = writeDryRunArtifact({
      category: CATEGORY,
      slot,
      title,
      content,
      imagePaths,
      metadata: { evidenceCount: evidenceItems.length, quality, ...formatterMetadata, ...slotMetadata, fixture: ARGS.fixture, imageAttachmentDisabled: true },
    });
    await logPublish({ slot, title, content, imageUrls: [], status: 'dry_run', metadata: { evidenceCount: evidenceItems.length, quality, ...formatterMetadata, ...slotMetadata, fixture: ARGS.fixture, artifact, imageAttachmentDisabled: true } });
    console.log('[edu-x/overseas] ✅ DRY-RUN 완료');
    await sendTelegram(`🔍 [edu-x/overseas] Dry-run ${slot} — ${content.length}자, 이미지 첨부 없음`);
    emitJsonIfRequested(ARGS.json, { ok: true, category: CATEGORY, slot, status: 'dry_run', quality, artifact, imagePaths, watchPoints, previousWatchPoints });
    return;
  }

  const liveGate = assertLivePublishAllowed({ tableOk: dbTable.ok, oneOffLiveTest: ARGS.oneOffLiveTest, fixture: ARGS.fixture });
  if (!liveGate.ok) {
    const errMsg = `live_publish_blocked: ${liveGate.reasons.join('; ')}`;
    await logPublish({ slot, title, content, imageUrls: [], status: 'skipped', errorMsg: errMsg, metadata: { liveGate, quality, ...formatterMetadata, ...slotMetadata, imageAttachmentDisabled: true } });
    console.error(`[edu-x/overseas] ${errMsg}`);
    emitJsonIfRequested(ARGS.json, { ok: false, category: CATEGORY, slot, status: 'live_blocked', reasons: liveGate.reasons });
    return;
  }

  const imageUrls = [];
  const finalContent = formatContentForEduXWeb(content);
  const publishTitle = titleForPublish(title, liveGate);

  const client = getEduxClient();
  const result = await client.post({ title: publishTitle, content: finalContent });
  if (!result?.id) {
    await logPublish({ slot, title: publishTitle, content: finalContent, imageUrls, status: 'fail', errorMsg: 'API 발행 실패', metadata: { result, liveGate, ...formatterMetadata, ...slotMetadata, imageAttachmentDisabled: true, contentFormat: 'html_blocks' } });
    await sendTelegram(`❌ [edu-x/overseas] ${slot} 발행 실패`);
    return;
  }

  const postId = result.id;
  const postUrl = postUrlFor(client.getBaseUrl ? client.getBaseUrl() : 'https://edu-x.io', postId);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  await logPublish({ slot, postId, postUrl, title: publishTitle, content: finalContent, imageUrls, status: 'success', metadata: { elapsedSec: Number(elapsed), liveGate, ...formatterMetadata, ...slotMetadata, imageAttachmentDisabled: true, contentFormat: 'html_blocks' } });
  console.log(`[edu-x/overseas] ✅ 발행 성공: ${postUrl} (${elapsed}s)`);
  if (shouldSendPublishSuccessTelegram({ args: ARGS, liveGate })) {
    await sendTelegram(`✅ [edu-x/overseas] ${slot} 발행 완료!\n📝 ${publishTitle}\n🔗 ${postUrl}`);
  } else {
    console.log('[edu-x/overseas] one-off live test 성공 알림 억제됨');
  }
  emitJsonIfRequested(ARGS.json, { ok: true, category: CATEGORY, slot, status: 'success', postId, postUrl, quality });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[edu-x/overseas] 치명적 오류:', err);
    process.exit(1);
  });
}

module.exports = { main, fetchOverseasMarketData, fetchOverseasEvidenceItems };
