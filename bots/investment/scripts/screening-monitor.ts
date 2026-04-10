// @ts-nocheck
/**
 * scripts/screening-monitor.js — 아르고스 스크리닝 장애 모니터
 *
 * - 스크리닝 실패 횟수 추적 (PostgreSQL 기반)
 * - 연속 3회 이상 실패 시 텔레그램 알림
 * - 스크리닝 성공 시 카운터 초기화
 */

import { createRequire } from 'module';
import { publishToMainBot } from '../shared/mainbot-client.ts';

const require      = createRequire(import.meta.url);
const pgPool       = require('../../../packages/core/lib/pg-pool');
const SCHEMA       = 'investment';
const ALERT_THRESHOLD = 3;  // 연속 실패 3회 초과 시 알림

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

  console.warn(`  ⚠️ [스크리닝 모니터] ${market} 실패 ${count}회 누적`);

  let lastAlertAt = null;
  if (count >= ALERT_THRESHOLD) {
    const now       = Date.now();
    const lastAlert = state.lastAlertAt?.[market] || 0;
    if (now - lastAlert > 2 * 3600 * 1000) {
      const label = market === 'domestic' ? '국내주식' : market === 'overseas' ? '미국주식' : '암호화폐';
      const msg   = `⚠️ [스크리닝 장애] ${label} 아르고스 스크리닝 ${count}회 연속 실패\n오류: ${errorMsg?.slice(0, 100)}\n→ 보유 포지션만 처리 중`;
      console.error(msg);
      try {
        await publishToMainBot({ from_bot: 'argos', event_type: 'alert', alert_level: 2, message: msg });
      } catch { /* 알림 실패 무시 */ }
      lastAlertAt = now;
    }
  }

  try {
    await saveMarketState(market, count, lastAlertAt);
  } catch { /* 무시 */ }
}
