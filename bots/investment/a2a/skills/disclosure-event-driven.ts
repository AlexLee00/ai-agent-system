// @ts-nocheck

import { query as defaultQuery } from '../../shared/db.ts';
import {
  classifyDisclosureReport,
  normalizeOpenDartDisclosure,
  scoreDisclosureImportance,
} from '../../lib/korea-data/opendart-client.ts';
import { registerSkillHandler } from '../handlers/task-handler.ts';

function directionFor(type) {
  if (type === 'shareholder_return' || type === 'earnings') return 'positive_watchlist';
  if (type === 'dilution' || type === 'risk_event') return 'avoid_or_reduce_watchlist';
  if (type === 'corporate_action') return 'event_review';
  return 'observe';
}

async function loadRecentDisclosures(queryFn, params = {}) {
  if (params.disclosure) return [normalizeOpenDartDisclosure(params.disclosure)];
  const rows = await Promise.resolve(queryFn(
    `SELECT corp_code, stock_code, company_name AS corp_name, rcept_no, rcept_dt, report_nm,
            report_type, importance_score, keywords, raw_data
       FROM investment.corp_disclosures
      WHERE ($1::text IS NULL OR stock_code = $1)
      ORDER BY rcept_dt DESC NULLS LAST, importance_score DESC, collected_at DESC
      LIMIT $2`,
    [params.symbol || params.stockCode || null, Math.max(1, Number(params.limit || 20))],
  )).catch(() => []);
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    corpCode: row.corp_code,
    stockCode: row.stock_code,
    corpName: row.corp_name,
    receiptNo: row.rcept_no,
    receiptDate: row.rcept_dt,
    reportName: row.report_nm,
    reportType: row.report_type || classifyDisclosureReport(row.report_nm),
    importanceScore: Number(row.importance_score || scoreDisclosureImportance({ reportName: row.report_nm })),
    keywords: row.keywords || [],
    raw: row.raw_data || row,
  }));
}

export function createDisclosureEventDrivenHandler({ queryFn = defaultQuery, skillId = 'disclosure-event-driven' } = {}) {
  return async function disclosureEventDriven(params = {}) {
    const rows = await loadRecentDisclosures(queryFn, params);
    const events = rows.map((row) => ({
      stockCode: row.stockCode,
      companyName: row.corpName,
      reportName: row.reportName,
      reportType: row.reportType,
      importanceScore: row.importanceScore,
      direction: directionFor(row.reportType),
      keywords: row.keywords || [],
      receiptNo: row.receiptNo,
      receiptDate: row.receiptDate,
      shadowOnly: true,
      liveOrderAllowed: false,
    }));
    return {
      status: 'completed',
      output: {
        ok: true,
        skill: skillId,
        market: 'domestic',
        shadowOnly: true,
        liveOrderAllowed: false,
        dataHealth: rows.length ? 'shadow_ready' : 'missing_disclosures',
        events,
        highImportanceEvents: events.filter((event) => event.importanceScore >= 7),
        hubLlmPolicy: {
          requiredBeforePromotion: true,
          deterministicFallback: true,
        },
        evidence: { source: rows.length ? 'investment.corp_disclosures' : 'params.disclosure' },
      },
      metadata: { shadowOnly: true, liveOrderAllowed: false },
    };
  };
}

export function registerDisclosureEventDrivenSkill(options = {}) {
  registerSkillHandler('disclosure-event-driven', createDisclosureEventDrivenHandler(options));
}

export default { createDisclosureEventDrivenHandler, registerDisclosureEventDrivenSkill };
