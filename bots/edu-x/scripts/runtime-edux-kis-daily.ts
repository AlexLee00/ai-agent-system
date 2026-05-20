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
const CATEGORY = 'kis';
const SLOT = '0900';

function titleForPublish(title, liveGate) {
  return liveGate?.mode === 'one_off_live_test' ? `[TEST] ${title}` : title;
}

// ─── KIS 데이터 수집 ──────────────────────────────────────────────

async function fetchKisMarketData() {
  if (ARGS.fixture) return getFixturePayload(CATEGORY).marketData || {};
  try {
    if (!pgPool) return {};
    // 루나팀 KIS WebSocket 데이터에서 최신 코스피/코스닥 조회
    const result = await dbQuery(pgPool, `
      SELECT symbol, action, confidence, reasoning, analyst_signals, block_meta, strategy_family, created_at
      FROM investment.signals
      WHERE exchange = 'kis'
        AND created_at >= NOW() - INTERVAL '12 hours'
      ORDER BY created_at DESC
      LIMIT 20
    `, [], 'public');
    const rows = result?.rows || [];

    // KIS 데이터에서 지수 추출 (raw_ref에 포함)
    const kisRow = rows.find((r) => r.block_meta?.kospi_index || r.block_meta?.triggerEvent || r.block_meta?.executionPrice);
    return {
      kospi_index: kisRow?.block_meta?.kospi_index || null,
      kospi_change: kisRow?.block_meta?.kospi_change || null,
      kosdaq_index: kisRow?.block_meta?.kosdaq_index || null,
      kosdaq_change: kisRow?.block_meta?.kosdaq_change || null,
      usd_krw: kisRow?.block_meta?.usd_krw || null,
      foreign_net_buy: kisRow?.block_meta?.foreign_net_buy || null,
      institution_net_buy: kisRow?.block_meta?.institution_net_buy || null,
      sectors: kisRow?.block_meta?.sectors || [
        { name: '반도체', change: null, change_1d: null },
        { name: '2차전지', change: null, change_1d: null },
        { name: '바이오', change: null, change_1d: null },
      ],
      indexSeries: kisRow?.block_meta?.indexSeries || {},
      events: kisRow?.block_meta?.events || [],
    };
  } catch (err) {
    console.warn('[edu-x/kis] KIS 데이터 수집 실패:', err?.message);
    return {};
  }
}

async function fetchKisEvidenceItems() {
  if (ARGS.fixture) return getFixturePayload(CATEGORY).evidenceItems || [];
  try {
    if (!pgPool) return [];
    const result = await dbQuery(pgPool, `
      SELECT symbol, action, confidence, reasoning, analyst_signals, block_meta, strategy_family
      FROM investment.signals
      WHERE exchange = 'kis'
        AND created_at >= NOW() - INTERVAL '12 hours'
      ORDER BY confidence DESC NULLS LAST, created_at DESC
      LIMIT 10
    `, [], 'public');
    return (result?.rows || []).map((r) => ({
      sourceName: r.strategy_family || r.analyst_signals || 'luna-kis-signal',
      signalDirection: r.action,
      evidenceSummary: r.reasoning,
      rawRef: { ...(r.block_meta || {}), mentions: Math.round(Number(r.confidence || 0) * 100) },
      symbol: r.symbol,
    }));
  } catch (err) {
    console.warn('[edu-x/kis] evidence 수집 실패:', err?.message);
    return [];
  }
}

// ─── 공용 유틸 ────────────────────────────────────────────────────

async function checkAlreadyPublished() {
  const result = await checkAlreadyPublishedCommon(pgPool, { category: CATEGORY, slot: SLOT, dryRun: DRY_RUN });
  return result.already;
}

async function logPublish({ postId, postUrl, title, content, imageUrls, status, errorMsg, metadata }) {
  const result = await insertPublishLog(pgPool, { category: CATEGORY, slot: SLOT, postId, postUrl, title, content, imageUrls, status, errorMsg, metadata });
  if (!result.ok) console.warn('[edu-x/kis] 로그 저장 스킵/실패:', result.reason);
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
  console.log(`[edu-x/kis] ${dryRunLabel}시작 — 슬롯: ${SLOT}, fixture=${ARGS.fixture}, db=${dbTable.reason}`);

  if (!DRY_RUN && !dbTable.ok) {
    const liveGate = assertLivePublishAllowed({ tableOk: false, oneOffLiveTest: ARGS.oneOffLiveTest, fixture: ARGS.fixture });
    console.error('[edu-x/kis] live 차단:', liveGate.reasons.join('; '));
    emitJsonIfRequested(ARGS.json, { ok: false, category: CATEGORY, slot: SLOT, status: 'live_blocked', reasons: liveGate.reasons });
    return;
  }

  const alreadyDone = await checkAlreadyPublished();
  if (alreadyDone && !(ARGS.oneOffLiveTest && !DRY_RUN)) {
    console.log('[edu-x/kis] 오늘 이미 발행됨 → 스킵');
    emitJsonIfRequested(ARGS.json, { ok: true, category: CATEGORY, slot: SLOT, status: 'skipped_already_published', dryRun: DRY_RUN });
    return;
  } else if (alreadyDone) {
    console.warn('[edu-x/kis] one-off live test — 슬롯 중복 발행 확인을 우회합니다.');
  }

  const [marketData, evidenceItems] = await Promise.allSettled([
    fetchKisMarketData(),
    fetchKisEvidenceItems(),
  ]).then((r) => [
    r[0].status === 'fulfilled' ? r[0].value : {},
    r[1].status === 'fulfilled' ? r[1].value : [],
  ]);

  const formatted = await formatPost(CATEGORY, SLOT, marketData, evidenceItems, {}, { fixture: ARGS.fixture });
  if (!formatted?.content) {
    await logPublish({ status: 'fail', errorMsg: '본문 생성 실패', content: '', imageUrls: [] });
    await sendTelegram(`❌ [edu-x/kis] ${dryRunLabel}${SLOT} 본문 생성 실패`);
    return;
  }

  const { title, content } = formatted;
  console.log(`[edu-x/kis] 본문: ${content.length}자`);

  const imagePaths = [];
  console.log('[edu-x/kis] 이미지 생성/업로드 비활성화 — 본문 텍스트만 게시');
  const quality = validatePostQuality({ content, imagePaths });
  if (!quality.ok) {
    const errMsg = `품질 게이트 미달: ${JSON.stringify(quality)}`;
    await logPublish({ title, content, imageUrls: [], status: 'fail', errorMsg: errMsg, metadata: { quality, formatterSource: formatted.source, imageAttachmentDisabled: true } });
    console.error(`[edu-x/kis] ${errMsg}`);
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
    console.log(`[edu-x/kis] ✅ DRY-RUN 완료`);
    await sendTelegram(`🔍 [edu-x/kis] Dry-run ${SLOT} — ${content.length}자, 이미지 첨부 없음`);
    emitJsonIfRequested(ARGS.json, { ok: true, category: CATEGORY, slot: SLOT, status: 'dry_run', quality, artifact, imagePaths });
    return;
  }

  const liveGate = assertLivePublishAllowed({ tableOk: dbTable.ok, oneOffLiveTest: ARGS.oneOffLiveTest, fixture: ARGS.fixture });
  if (!liveGate.ok) {
    const errMsg = `live_publish_blocked: ${liveGate.reasons.join('; ')}`;
    await logPublish({ title, content, imageUrls: [], status: 'skipped', errorMsg: errMsg, metadata: { liveGate, quality, imageAttachmentDisabled: true } });
    console.error(`[edu-x/kis] ${errMsg}`);
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
    await sendTelegram(`❌ [edu-x/kis] ${SLOT} 발행 실패`);
    return;
  }

  const postId = result.id;
  const postUrl = postUrlFor(client.getBaseUrl ? client.getBaseUrl() : 'https://edu-x.io', postId);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  await logPublish({ postId, postUrl, title: publishTitle, content: finalContent, imageUrls, status: 'success', metadata: { elapsedSec: Number(elapsed), liveGate, imageAttachmentDisabled: true, contentFormat: 'html_blocks' } });
  console.log(`[edu-x/kis] ✅ 발행 성공: ${postUrl} (${elapsed}s)`);
  await sendTelegram(`✅ [edu-x/kis] ${SLOT} 발행 완료!\n📝 ${publishTitle}\n🔗 ${postUrl}`);
  emitJsonIfRequested(ARGS.json, { ok: true, category: CATEGORY, slot: SLOT, status: 'success', postId, postUrl, quality });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[edu-x/kis] 치명적 오류:', err);
    process.exit(1);
  });
}

module.exports = { main, fetchKisMarketData, fetchKisEvidenceItems };
