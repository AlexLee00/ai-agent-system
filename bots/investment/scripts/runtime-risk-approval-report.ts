#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { initJournalSchema } from '../shared/trade-journal-db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  return {
    days: Math.max(1, Number(daysArg?.split('=').slice(1).join('=') || 30)),
    json: argv.includes('--json'),
  };
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pct(value, digits = 1) {
  if (value == null) return 'n/a';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'n/a';
  return `${n.toFixed(digits)}%`;
}

function normalizePreview(row = {}) {
  const preview = row.strategy_config?.risk_approval_preview || null;
  const application = row.strategy_config?.risk_approval_application || preview?.application || null;
  const journalStatus = String(row.journal_status || '').toLowerCase();
  const closed = journalStatus === 'closed' || row.exit_time != null;
  return {
    tradeId: row.trade_id || null,
    signalId: row.signal_id || null,
    symbol: row.symbol || null,
    exchange: row.exchange || null,
    journalStatus: row.journal_status || null,
    closed,
    pnlNet: row.pnl_net != null ? Number(row.pnl_net) : null,
    pnlPercent: row.pnl_percent != null ? Number(row.pnl_percent) : null,
    exitReason: row.exit_reason || null,
    createdAt: row.created_at != null ? Number(row.created_at) : null,
    nemesisVerdict: row.nemesis_verdict || null,
    positionSizeOriginal: row.position_size_original != null ? Number(row.position_size_original) : null,
    positionSizeApproved: row.position_size_approved != null ? Number(row.position_size_approved) : null,
    preview,
    application,
  };
}

function makeOutcomeBucket(key) {
  return {
    key,
    total: 0,
    closed: 0,
    wins: 0,
    pnlNet: 0,
    pnlPercentWeightedSum: 0,
  };
}

function addOutcome(bucket, row) {
  bucket.total += 1;
  if (!row.closed) return;
  bucket.closed += 1;
  const pnlNet = safeNumber(row.pnlNet);
  const pnlPercent = row.pnlPercent != null ? Number(row.pnlPercent) : null;
  bucket.pnlNet += pnlNet;
  if (pnlNet > 0 || Number(pnlPercent || 0) > 0) bucket.wins += 1;
  if (pnlPercent != null && Number.isFinite(pnlPercent)) {
    bucket.pnlPercentWeightedSum += pnlPercent;
  }
}

function finalizeOutcomeBucket(bucket, extra = {}) {
  return {
    ...extra,
    total: bucket.total,
    closed: bucket.closed,
    wins: bucket.wins,
    winRate: bucket.closed > 0 ? Number(((bucket.wins / bucket.closed) * 100).toFixed(1)) : null,
    avgPnlPercent: bucket.closed > 0 ? Number((bucket.pnlPercentWeightedSum / bucket.closed).toFixed(4)) : null,
    pnlNet: Number(bucket.pnlNet.toFixed(4)),
  };
}

export function summarizeRuntimeRiskApprovalRows(rows = []) {
  const byModel = {};
  const byDecision = {};
  const byMode = {};
  const byPreviewStatus = {};
  const outcomeTotal = makeOutcomeBucket('total');
  const outcomeByMode = {};
  const outcomeByModel = {};
  const divergences = [];
  let total = 0;
  let previewRejects = 0;
  let legacyApprovedPreviewRejected = 0;
  let applicationApplied = 0;
  let applicationRejected = 0;
  let applicationAmountDelta = 0;
  let totalOriginal = 0;
  let totalApproved = 0;
  let totalPreviewFinal = 0;
  let previewAmountReductions = 0;
  let previewAmountIncreases = 0;

  for (const row of rows) {
    if (!row.preview) continue;
    total += 1;
    const previewDecision = row.preview.decision || 'unknown';
    byDecision[previewDecision] = (byDecision[previewDecision] || 0) + 1;
    if (row.preview.approved === false || previewDecision === 'REJECT') previewRejects += 1;
    const application = row.application || {};
    const mode = String(application.mode || row.preview.mode || 'shadow');
    const previewStatus = String(application.previewStatus || 'unknown');
    addOutcome(outcomeTotal, row);
    if (!outcomeByMode[mode]) outcomeByMode[mode] = makeOutcomeBucket(mode);
    addOutcome(outcomeByMode[mode], row);
    byPreviewStatus[previewStatus] = (byPreviewStatus[previewStatus] || 0) + 1;
    if (!byMode[mode]) byMode[mode] = { mode, total: 0, applied: 0, rejected: 0, amountDelta: 0 };
    byMode[mode].total += 1;
    if (application.applied) {
      byMode[mode].applied += 1;
      applicationApplied += 1;
    }
    if (String(row.nemesisVerdict || '').toLowerCase() === 'rejected' && mode === 'enforce') {
      byMode[mode].rejected += 1;
      applicationRejected += 1;
    }
    const appDelta = safeNumber(application.amountAfter) - safeNumber(application.amountBefore);
    byMode[mode].amountDelta += appDelta;
    applicationAmountDelta += appDelta;

    const legacyApproved = ['approved', 'modified'].includes(String(row.nemesisVerdict || '').toLowerCase());
    if (legacyApproved && (row.preview.approved === false || previewDecision === 'REJECT')) {
      legacyApprovedPreviewRejected += 1;
      if (divergences.length < 12) {
        divergences.push({
          symbol: row.symbol,
          exchange: row.exchange,
          nemesisVerdict: row.nemesisVerdict,
          previewDecision,
          rejectReason: row.preview.rejectReason || null,
          finalAmount: row.preview.finalAmount ?? null,
        });
      }
    }

    if (row.positionSizeOriginal != null) totalOriginal += Number(row.positionSizeOriginal || 0);
    if (row.positionSizeApproved != null) totalApproved += Number(row.positionSizeApproved || 0);
    if (row.preview.finalAmount != null) totalPreviewFinal += Number(row.preview.finalAmount || 0);
    if (row.positionSizeApproved != null && row.preview.finalAmount != null) {
      const amountDelta = Number(row.preview.finalAmount || 0) - Number(row.positionSizeApproved || 0);
      if (amountDelta < -0.0001) previewAmountReductions += 1;
      if (amountDelta > 0.0001) previewAmountIncreases += 1;
    }

    for (const step of row.preview.steps || []) {
      const model = step.model || 'unknown';
      if (!byModel[model]) {
        byModel[model] = {
          model,
          total: 0,
          pass: 0,
          adjust: 0,
          reject: 0,
          amountDelta: 0,
          reasons: {},
        };
      }
      const bucket = byModel[model];
      const decision = String(step.decision || 'PASS').toUpperCase();
      bucket.total += 1;
      if (decision === 'REJECT') bucket.reject += 1;
      else if (decision === 'ADJUST') bucket.adjust += 1;
      else bucket.pass += 1;
      bucket.amountDelta += safeNumber(step.amountAfter) - safeNumber(step.amountBefore);
      const reason = String(step.reason || 'unknown').slice(0, 120);
      bucket.reasons[reason] = (bucket.reasons[reason] || 0) + 1;

      if (!outcomeByModel[model]) outcomeByModel[model] = makeOutcomeBucket(model);
      addOutcome(outcomeByModel[model], row);
    }
  }

  const modelRows = Object.values(byModel).map((item) => {
    const topReason = Object.entries(item.reasons).sort((a, b) => Number(b[1]) - Number(a[1]))[0] || null;
    return {
      model: item.model,
      total: item.total,
      pass: item.pass,
      adjust: item.adjust,
      reject: item.reject,
      adjustRate: item.total > 0 ? item.adjust / item.total : 0,
      rejectRate: item.total > 0 ? item.reject / item.total : 0,
      amountDelta: Number(item.amountDelta.toFixed(4)),
      topReason: topReason ? { reason: topReason[0], count: Number(topReason[1]) } : null,
    };
  }).sort((a, b) => b.adjust + b.reject - (a.adjust + a.reject));

  return {
    total,
    previewRejects,
    legacyApprovedPreviewRejected,
    byDecision,
    amount: {
      original: Number(totalOriginal.toFixed(4)),
      approved: Number(totalApproved.toFixed(4)),
      previewFinal: Number(totalPreviewFinal.toFixed(4)),
      previewVsApprovedDelta: Number((totalPreviewFinal - totalApproved).toFixed(4)),
      previewAmountReductions,
      previewAmountIncreases,
      byPreviewStatus,
    },
    application: {
      applied: applicationApplied,
      rejected: applicationRejected,
      amountDelta: Number(applicationAmountDelta.toFixed(4)),
      byMode: Object.values(byMode).map((item) => ({
        ...item,
        amountDelta: Number(item.amountDelta.toFixed(4)),
      })),
    },
    outcome: {
      total: finalizeOutcomeBucket(outcomeTotal),
      byMode: Object.entries(outcomeByMode)
        .map(([mode, bucket]) => finalizeOutcomeBucket(bucket, { mode }))
        .sort((a, b) => Number(b.closed || 0) - Number(a.closed || 0)),
      byModel: Object.entries(outcomeByModel)
        .map(([model, bucket]) => finalizeOutcomeBucket(bucket, { model }))
        .sort((a, b) => Number(b.closed || 0) - Number(a.closed || 0)),
    },
    modelRows,
    divergences,
  };
}

export function buildRuntimeRiskApprovalDecision(summary) {
  let status = 'risk_approval_preview_empty';
  let headline = 'risk approval preview가 아직 충분히 쌓이지 않았습니다.';
  const reasons = [`preview ${summary.total}건`, `preview rejects ${summary.previewRejects}건`, `legacy-approved/preview-rejected ${summary.legacyApprovedPreviewRejected}건`];
  if (summary.outcome?.total) {
    reasons.push(`closed outcomes ${summary.outcome.total.closed}건, pnl ${summary.outcome.total.pnlNet}`);
  }
  const actionItems = ['네메시스 rationale에 risk_approval_preview 표본을 더 누적합니다.'];

  if (summary.total > 0) {
    status = summary.legacyApprovedPreviewRejected > 0
      ? 'risk_approval_preview_divergence'
      : summary.previewRejects > 0
        ? 'risk_approval_preview_watch'
        : 'risk_approval_preview_ok';
    headline = summary.legacyApprovedPreviewRejected > 0
      ? '기존 네메시스 승인과 새 리스크 체인 preview가 엇갈리는 표본이 있습니다.'
      : summary.previewRejects > 0
        ? '새 리스크 체인 preview가 일부 신호를 거절 후보로 보고 있습니다.'
        : '새 리스크 체인 preview와 기존 승인 흐름이 큰 충돌 없이 누적되고 있습니다.';
    actionItems.length = 0;
    if (summary.legacyApprovedPreviewRejected > 0) actionItems.push('divergence sample을 검토해 consensus/regime/feedback 모델 임계값을 보정합니다.');
    if (Number(summary.outcome?.total?.closed || 0) > 0 && Number(summary.outcome?.total?.avgPnlPercent || 0) < 0) {
      actionItems.push('risk approval outcome 손익이 음수인 모드/모델을 확인해 assist 감산율과 enforce 전환 조건을 보수적으로 재검토합니다.');
    }
    actionItems.push('preview 안정성이 확인되면 네메시스 승인 금액 조정에 단계적으로 반영합니다.');
  }

  return { status, headline, reasons, actionItems };
}

function renderText(payload) {
  const lines = [
    '🛡️ Runtime Risk Approval Report',
    `period: ${payload.days}d`,
    `status: ${payload.decision.status}`,
    `headline: ${payload.decision.headline}`,
    '',
    '근거:',
    ...payload.decision.reasons.map((reason) => `- ${reason}`),
    '',
    '모델별:',
  ];
  if (payload.summary.modelRows.length === 0) lines.push('- 데이터 없음');
  for (const row of payload.summary.modelRows) {
    lines.push(`- ${row.model}: total ${row.total}, adjust ${row.adjust} (${pct(row.adjustRate * 100)}), reject ${row.reject} (${pct(row.rejectRate * 100)}), delta ${row.amountDelta}, top ${row.topReason?.reason || 'n/a'}`);
  }
  lines.push('');
  lines.push(`금액: approved ${payload.summary.amount.approved} / preview ${payload.summary.amount.previewFinal} / delta ${payload.summary.amount.previewVsApprovedDelta}`);
  if (payload.summary.amount?.byPreviewStatus) {
    const previewStatusLine = Object.entries(payload.summary.amount.byPreviewStatus)
      .map(([key, value]) => `${key}:${value}`)
      .join(', ');
    lines.push(`preview status: ${previewStatusLine || 'none'}`);
  }
  if (payload.summary.application?.byMode?.length) {
    lines.push(`적용: applied ${payload.summary.application.applied} / rejected ${payload.summary.application.rejected} / amount delta ${payload.summary.application.amountDelta}`);
    for (const item of payload.summary.application.byMode) {
      lines.push(`- mode ${item.mode}: total ${item.total}, applied ${item.applied}, rejected ${item.rejected}, delta ${item.amountDelta}`);
    }
  }
  if (payload.summary.outcome?.total) {
    const outcome = payload.summary.outcome.total;
    lines.push(`성과 귀속: closed ${outcome.closed}/${outcome.total}, win ${pct(outcome.winRate)}, avg ${pct(outcome.avgPnlPercent, 2)}, pnl ${outcome.pnlNet}`);
    for (const item of payload.summary.outcome.byMode || []) {
      lines.push(`- outcome mode ${item.mode}: closed ${item.closed}/${item.total}, win ${pct(item.winRate)}, avg ${pct(item.avgPnlPercent, 2)}, pnl ${item.pnlNet}`);
    }
    for (const item of (payload.summary.outcome.byModel || []).slice(0, 5)) {
      lines.push(`- outcome model ${item.model}: closed ${item.closed}/${item.total}, win ${pct(item.winRate)}, avg ${pct(item.avgPnlPercent, 2)}, pnl ${item.pnlNet}`);
    }
  }
  if (payload.summary.divergences.length) {
    lines.push('');
    lines.push('divergence samples:');
    for (const item of payload.summary.divergences) {
      lines.push(`- ${item.exchange}/${item.symbol}: nemesis ${item.nemesisVerdict} vs preview ${item.previewDecision} (${item.rejectReason || 'n/a'})`);
    }
  }
  lines.push('');
  lines.push('권장 조치:');
  lines.push(...payload.decision.actionItems.map((item) => `- ${item}`));
  return lines.join('\n');
}

export async function buildRuntimeRiskApprovalReport({ days = 30, json = false } = {}) {
  await db.initSchema();
  await initJournalSchema();
  const since = Date.now() - Math.max(1, Number(days || 30)) * 24 * 60 * 60 * 1000;
  const rawRows = await db.query(`
    SELECT
      r.trade_id,
      r.signal_id,
      j.symbol,
      j.exchange,
      j.status AS journal_status,
      j.exit_time,
      j.exit_reason,
      j.pnl_net,
      j.pnl_percent,
      r.created_at,
      r.nemesis_verdict,
      r.position_size_original,
      r.position_size_approved,
      r.strategy_config
    FROM investment.trade_rationale r
    LEFT JOIN investment.trade_journal j ON j.trade_id = r.trade_id OR j.signal_id = r.signal_id
    WHERE r.created_at >= $1
      AND r.strategy_config ? 'risk_approval_preview'
    ORDER BY r.created_at DESC
  `, [since]).catch(() => []);
  const rows = rawRows.map(normalizePreview);
  const summary = summarizeRuntimeRiskApprovalRows(rows);
  const decision = buildRuntimeRiskApprovalDecision(summary);
  const payload = {
    ok: true,
    days: Number(days),
    generatedAt: new Date().toISOString(),
    count: rows.length,
    summary,
    decision,
    rows: rows.slice(0, 25),
  };
  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeRiskApprovalReport(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-risk-approval-report 오류:',
  });
}
