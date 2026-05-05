// @ts-nocheck
/**
 * scripts/screening-monitor.js — 아르고스 스크리닝 장애 모니터
 *
 * - 스크리닝 실패 횟수 추적 (PostgreSQL 기반)
 * - 연속 3회 이상 실패 시 텔레그램 알림
 * - 스크리닝 성공 시 카운터 초기화
 */

import { createRequire } from 'module';
import { publishAlert } from '../shared/alert-publisher.ts';

const require      = createRequire(import.meta.url);
const pgPool       = require('../../../packages/core/lib/pg-pool');
const SCHEMA       = 'investment';
const ALERT_THRESHOLD = 3;  // 연속 실패 3회 초과 시 알림

export function classifyScreeningAlertRoute(market, errorMsg = '') {
  const text = String(errorMsg || '');
  const lower = text.toLowerCase();
  const label = market === 'domestic' ? '국내주식' : market === 'overseas' ? '미국주식' : '암호화폐';

  const isOverseasQuoteGap =
    market === 'overseas'
    && (
      lower.includes('overseas_quote_or_liquidity_filtered_all')
      || (lower.includes('quoteuniverse=') && lower.includes('quotemap=0'))
    );

  if (isOverseasQuoteGap) {
    return {
      label,
      visibility: 'digest',
      alarm_type: 'report',
      actionability: 'none',
      title: `${label} 아르고스 스크리닝 관찰`,
      messagePrefix: `ℹ️ [스크리닝 관찰] ${label} 아르고스 스크리닝 소스 품질 저하`,
      incident_key: `investment:argos:screening_source_gap:${market}`,
    };
  }

  return {
    label,
    visibility: 'notify',
    alarm_type: 'error',
    actionability: 'auto_repair',
    title: `${label} 아르고스 스크리닝 장애`,
    messagePrefix: `⚠️ [스크리닝 장애] ${label} 아르고스 스크리닝`,
    incident_key: `investment:argos:screening_failure:${market}`,
  };
}

// ── 테이블 초기화 (최초 1회) ──────────────────────────────────────
async function ensureTable() {
  await pgPool.run(SCHEMA, `
    CREATE TABLE IF NOT EXISTS screening_monitor (
      market        VARCHAR(20) PRIMARY KEY,
      fail_count    INTEGER     DEFAULT 0,
      last_alert_at TIMESTAMPTZ,
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function loadMonitorState() {
  try {
    await ensureTable();
    const rows = await pgPool.query(SCHEMA,
      'SELECT market, fail_count, last_alert_at FROM screening_monitor'
    );
    const state = { domestic: 0, overseas: 0, crypto: 0, lastAlertAt: {} };
    rows.forEach(r => {
      state[r.market]              = r.fail_count || 0;
      state.lastAlertAt[r.market]  = r.last_alert_at ? new Date(r.last_alert_at).getTime() : 0;
    });
    return state;
  } catch {
    return { domestic: 0, overseas: 0, crypto: 0, lastAlertAt: {} };
  }
}

async function saveMarketState(market, failCount, lastAlertAt = null) {
  await pgPool.run(SCHEMA, `
    INSERT INTO screening_monitor (market, fail_count, last_alert_at, updated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (market)
    DO UPDATE SET
      fail_count    = $2,
      last_alert_at = COALESCE($3, screening_monitor.last_alert_at),
      updated_at    = NOW()
  `, [market, failCount, lastAlertAt ? new Date(lastAlertAt) : null]);
}

/**
 * 스크리닝 성공 시 호출 — 카운터 초기화
 * @param {'domestic'|'overseas'|'crypto'} market
 */
export async function recordScreeningSuccess(market) {
  try {
    await saveMarketState(market, 0);
  } catch { /* 무시 */ }
}

/**
 * 스크리닝 실패 시 호출 — 카운터 증가, 임계 초과 시 텔레그램 알림
 * @param {'domestic'|'overseas'|'crypto'} market
 * @param {string} errorMsg
 */
export async function recordScreeningFailure(market, errorMsg) {
  const state = await loadMonitorState();
  const count = (state[market] || 0) + 1;
  const route = classifyScreeningAlertRoute(market, errorMsg);

  console.warn(`  ⚠️ [스크리닝 모니터] ${market} 실패 ${count}회 누적`);

  let lastAlertAt = null;
  if (count >= ALERT_THRESHOLD) {
    const now       = Date.now();
    const lastAlert = state.lastAlertAt?.[market] || 0;
    if (now - lastAlert > 2 * 3600 * 1000) {
      const msg   = `${route.messagePrefix} ${count}회 연속 실패\n오류: ${errorMsg?.slice(0, 100)}\n→ 보유 포지션만 처리 중`;
      console.error(msg);
      try {
        await publishAlert({
          from_bot: 'argos',
          team: 'investment',
          event_type: 'alert',
          alert_level: route.alarm_type === 'error' ? 2 : 1,
          message: msg,
          visibility: route.visibility,
          alarm_type: route.alarm_type,
          actionability: route.actionability,
          incident_key: route.incident_key,
          title: route.title,
          payload: {
            market,
            fail_count: count,
            error_code: route.incident_key.split(':').pop(),
            raw_error: String(errorMsg || '').slice(0, 200),
          },
        });
      } catch { /* 알림 실패 무시 */ }
      lastAlertAt = now;
    }
  }

  try {
    await saveMarketState(market, count, lastAlertAt);
  } catch { /* 무시 */ }
}
