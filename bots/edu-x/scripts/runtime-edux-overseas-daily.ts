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
const SLOT = '2200';

function titleForPublish(title, liveGate) {
  return liveGate?.mode === 'one_off_live_test' ? `[TEST] ${title}` : title;
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
      '^GSPC', '^IXIC', '^VIX', 'DX-Y.NYB',
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
      dxy: quoteMap['DX-Y.NYB']?.latest ? Number(quoteMap['DX-Y.NYB'].latest.toFixed(2)) : null,
      vix: quoteMap['^VIX']?.latest ? Number(quoteMap['^VIX'].latest.toFixed(2)) : null,
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

// ─── 공용 유틸 ────────────────────────────────────────────────────

async function checkAlreadyPublished() {
  const result = await checkAlreadyPublishedCommon(pgPool, { category: CATEGORY, slot: SLOT, dryRun: DRY_RUN });
  return result.already;
}

async function logPublish({ postId, postUrl, title, content, imageUrls, status, errorMsg, metadata }) {
  const testPost = ARGS.testPost === true || ARGS.oneOffLiveTest === true;
  const result = await insertPublishLog(pgPool, {
    category: CATEGORY,
    slot: SLOT,
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
  const dryRunLabel = DRY_RUN ? '[DRY-RUN] ' : '';
  const dbTable = await ensurePublishLogTable(pgPool);
  console.log(`[edu-x/overseas] ${dryRunLabel}시작 — 슬롯: ${SLOT}, fixture=${ARGS.fixture}, db=${dbTable.reason}`);

  if (!DRY_RUN && !dbTable.ok) {
    const liveGate = assertLivePublishAllowed({ tableOk: false, oneOffLiveTest: ARGS.oneOffLiveTest, fixture: ARGS.fixture });
    console.error('[edu-x/overseas] live 차단:', liveGate.reasons.join('; '));
    emitJsonIfRequested(ARGS.json, { ok: false, category: CATEGORY, slot: SLOT, status: 'live_blocked', reasons: liveGate.reasons });
    return;
  }

  const alreadyDone = await checkAlreadyPublished();
  if (alreadyDone && !(ARGS.oneOffLiveTest && !DRY_RUN)) {
    console.log('[edu-x/overseas] 오늘 이미 발행됨 → 스킵');
    emitJsonIfRequested(ARGS.json, { ok: true, category: CATEGORY, slot: SLOT, status: 'skipped_already_published', dryRun: DRY_RUN });
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

  const formatted = await formatPost(CATEGORY, SLOT, marketData, evidenceItems, {}, { fixture: ARGS.fixture });
  if (!formatted?.content) {
    await logPublish({ status: 'fail', errorMsg: '본문 생성 실패', content: '', imageUrls: [] });
    await sendTelegram(`❌ [edu-x/overseas] ${dryRunLabel}${SLOT} 본문 생성 실패`);
    return;
  }

  const { title, content } = formatted;
  console.log(`[edu-x/overseas] 본문: ${content.length}자`);

  const imagePaths = [];
  console.log('[edu-x/overseas] 이미지 생성/업로드 비활성화 — 본문 텍스트만 게시');
  const quality = validatePostQuality({ content, imagePaths, category: CATEGORY });
  if (!quality.ok) {
    const errMsg = `품질 게이트 미달: ${JSON.stringify(quality)}`;
    await logPublish({ title, content, imageUrls: [], status: 'fail', errorMsg: errMsg, metadata: { quality, formatterSource: formatted.source, imageAttachmentDisabled: true } });
    console.error(`[edu-x/overseas] ${errMsg}`);
    emitJsonIfRequested(ARGS.json, { ok: false, category: CATEGORY, slot: SLOT, status: 'quality_failed', quality });
    return;
  }

  if (DRY_RUN) {
    const artifact = writeDryRunArtifact({
      category: CATEGORY,
      slot: SLOT,
      title,
      content,
      imagePaths,
      metadata: { evidenceCount: evidenceItems.length, quality, formatterSource: formatted.source, fixture: ARGS.fixture, imageAttachmentDisabled: true },
    });
    await logPublish({ title, content, imageUrls: [], status: 'dry_run', metadata: { evidenceCount: evidenceItems.length, quality, formatterSource: formatted.source, fixture: ARGS.fixture, artifact, imageAttachmentDisabled: true } });
    console.log('[edu-x/overseas] ✅ DRY-RUN 완료');
    await sendTelegram(`🔍 [edu-x/overseas] Dry-run ${SLOT} — ${content.length}자, 이미지 첨부 없음`);
    emitJsonIfRequested(ARGS.json, { ok: true, category: CATEGORY, slot: SLOT, status: 'dry_run', quality, artifact, imagePaths });
    return;
  }

  const liveGate = assertLivePublishAllowed({ tableOk: dbTable.ok, oneOffLiveTest: ARGS.oneOffLiveTest, fixture: ARGS.fixture });
  if (!liveGate.ok) {
    const errMsg = `live_publish_blocked: ${liveGate.reasons.join('; ')}`;
    await logPublish({ title, content, imageUrls: [], status: 'skipped', errorMsg: errMsg, metadata: { liveGate, quality, imageAttachmentDisabled: true } });
    console.error(`[edu-x/overseas] ${errMsg}`);
    emitJsonIfRequested(ARGS.json, { ok: false, category: CATEGORY, slot: SLOT, status: 'live_blocked', reasons: liveGate.reasons });
    return;
  }

  const imageUrls = [];
  const finalContent = formatContentForEduXWeb(content);
  const publishTitle = titleForPublish(title, liveGate);

  const client = getEduxClient();
  const result = await client.post({ title: publishTitle, content: finalContent });
  if (!result?.id) {
    await logPublish({ title: publishTitle, content: finalContent, imageUrls, status: 'fail', errorMsg: 'API 발행 실패', metadata: { result, liveGate, imageAttachmentDisabled: true, contentFormat: 'html_blocks' } });
    await sendTelegram(`❌ [edu-x/overseas] ${SLOT} 발행 실패`);
    return;
  }

  const postId = result.id;
  const postUrl = postUrlFor(client.getBaseUrl ? client.getBaseUrl() : 'https://edu-x.io', postId);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  await logPublish({ postId, postUrl, title: publishTitle, content: finalContent, imageUrls, status: 'success', metadata: { elapsedSec: Number(elapsed), liveGate, imageAttachmentDisabled: true, contentFormat: 'html_blocks' } });
  console.log(`[edu-x/overseas] ✅ 발행 성공: ${postUrl} (${elapsed}s)`);
  if (shouldSendPublishSuccessTelegram({ args: ARGS, liveGate })) {
    await sendTelegram(`✅ [edu-x/overseas] ${SLOT} 발행 완료!\n📝 ${publishTitle}\n🔗 ${postUrl}`);
  } else {
    console.log('[edu-x/overseas] one-off live test 성공 알림 억제됨');
  }
  emitJsonIfRequested(ARGS.json, { ok: true, category: CATEGORY, slot: SLOT, status: 'success', postId, postUrl, quality });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[edu-x/overseas] 치명적 오류:', err);
    process.exit(1);
  });
}

module.exports = { main, fetchOverseasMarketData, fetchOverseasEvidenceItems };
