#!/usr/bin/env node

import * as db from '../shared/db.js';
import { pathToFileURL } from 'url';

const DOMESTIC_MIN_KRW = 10_000;
const DOMESTIC_MAX_KRW = 5_000_000;
const OVERSEAS_MIN_USD = 10;
const OVERSEAS_MAX_USD = 1_000;

function inferBlockInfo(row) {
  const exchange = row.exchange || 'unknown';
  const action = String(row.action || '').toUpperCase();
  const amount = Number(row.amount_usdt || 0);
  const existingReason = String(row.block_reason || '').trim();
  const baseMeta = {
    inferred: true,
    source: 'backfill-signal-block-reasons',
    exchange,
    symbol: row.symbol || null,
    action,
    amount_usdt: Number.isFinite(amount) ? amount : null,
    original_status: row.status || null,
    created_at: row.created_at || null,
  };

  if (existingReason.startsWith('최소 주문금액 미달')) {
    return {
      reason: existingReason,
      code: 'min_order_notional',
      meta: {
        ...baseMeta,
        market: exchange === 'kis' ? 'domestic' : exchange === 'kis_overseas' ? 'overseas' : 'crypto',
      },
    };
  }

  if (existingReason.startsWith('최대 주문금액 초과')) {
    return {
      reason: existingReason,
      code: 'max_order_notional',
      meta: {
        ...baseMeta,
        market: exchange === 'kis' ? 'domestic' : exchange === 'kis_overseas' ? 'overseas' : 'crypto',
      },
    };
  }

  if (existingReason === 'legacy_order_rejected_without_reason') {
    return {
      reason: existingReason,
      code: 'legacy_order_rejected',
      meta: {
        ...baseMeta,
        market: 'overseas',
        note: '구형 해외장 실패 이력으로 상세 원인 복원 불가',
      },
    };
  }

  if (existingReason === 'legacy_executor_failed_without_reason') {
    return {
      reason: existingReason,
      code: 'legacy_executor_failed',
      meta: {
        ...baseMeta,
        market: exchange === 'kis' ? 'domestic' : exchange === 'kis_overseas' ? 'overseas' : exchange === 'binance' ? 'crypto' : 'unknown',
        note: '구형 실행 실패 이력으로 상세 원인 복원 불가',
      },
    };
  }

  if (existingReason === 'cleanup:nemesis_error_pending_stale') {
    return {
      reason: existingReason,
      code: 'nemesis_error',
      meta: {
        ...baseMeta,
        stage: 'cleanup',
        note: '정리 단계에서 stale pending 신호를 제거한 이력',
      },
    };
  }

  if (exchange === 'kis') {
    if (action === 'BUY' && amount > 0 && amount < DOMESTIC_MIN_KRW) {
      return {
        reason: `최소 주문금액 미달 (${amount.toLocaleString()}원)`,
        code: 'min_order_notional',
        meta: {
          ...baseMeta,
          market: 'domestic',
          minimum_required: DOMESTIC_MIN_KRW,
          currency: 'KRW',
        },
      };
    }
    if (action === 'BUY' && amount > DOMESTIC_MAX_KRW) {
      return {
        reason: `최대 주문금액 초과 (${amount.toLocaleString()}원)`,
        code: 'max_order_notional',
        meta: {
          ...baseMeta,
          market: 'domestic',
          maximum_allowed: DOMESTIC_MAX_KRW,
          currency: 'KRW',
        },
      };
    }
    return {
      reason: 'legacy_executor_failed_without_reason',
      code: 'legacy_executor_failed',
      meta: {
        ...baseMeta,
        market: 'domestic',
        note: '구형 국내장 실패 이력으로 상세 원인 복원 불가',
      },
    };
  }

  if (exchange === 'kis_overseas') {
    if (action === 'BUY' && amount > 0 && amount < OVERSEAS_MIN_USD) {
      return {
        reason: `최소 주문금액 미달 ($${amount})`,
        code: 'min_order_notional',
        meta: {
          ...baseMeta,
          market: 'overseas',
          minimum_required: OVERSEAS_MIN_USD,
          currency: 'USD',
        },
      };
    }
    if (action === 'BUY' && amount > OVERSEAS_MAX_USD) {
      return {
        reason: `최대 주문금액 초과 ($${amount})`,
        code: 'max_order_notional',
        meta: {
          ...baseMeta,
          market: 'overseas',
          maximum_allowed: OVERSEAS_MAX_USD,
          currency: 'USD',
        },
      };
    }
    return {
      reason: 'legacy_order_rejected_without_reason',
      code: 'legacy_order_rejected',
      meta: {
        ...baseMeta,
        market: 'overseas',
        note: '구형 해외장 실패 이력으로 상세 원인 복원 불가',
      },
    };
  }

  if (exchange === 'binance') {
    return {
      reason: 'legacy_executor_failed_without_reason',
      code: 'legacy_executor_failed',
      meta: {
        ...baseMeta,
        market: 'crypto',
        note: '구형 암호화폐 실패 이력으로 상세 원인 복원 불가',
      },
    };
  }

  return {
    reason: 'legacy_missing_block_reason',
    code: 'legacy_missing_block_reason',
    meta: {
      ...baseMeta,
      note: '거래소 정보가 불충분해 상세 원인 복원 불가',
    },
  };
}

function inferReclassifiedBlockInfo(row) {
  const existingReason = String(row.block_reason || '').trim();
  const exchange = row.exchange || 'unknown';
  const action = String(row.action || '').toUpperCase();
  const amount = Number(row.amount_usdt || 0);
  const baseMeta = {
    reclassified: true,
    source: 'backfill-signal-block-reasons',
    exchange,
    symbol: row.symbol || null,
    action,
    amount_usdt: Number.isFinite(amount) ? amount : null,
    original_status: row.status || null,
    original_code: row.block_code || null,
    created_at: row.created_at || null,
    market: exchange === 'kis' ? 'domestic' : exchange === 'kis_overseas' ? 'overseas' : exchange === 'binance' ? 'crypto' : 'unknown',
  };

  if (
    exchange === 'kis'
    && action === 'BUY'
    && (existingReason.includes('[40070000]') || existingReason.includes('매매불가 종목'))
  ) {
    return {
      reason: existingReason,
      code: 'mock_untradable_symbol',
      meta: baseMeta,
    };
  }

  if (exchange === 'kis' && existingReason.includes('초당 거래건수를 초과')) {
    return {
      reason: existingReason,
      code: 'broker_rate_limited',
      meta: baseMeta,
    };
  }

  if (exchange === 'kis' && existingReason.includes('장종료')) {
    return {
      reason: existingReason,
      code: 'market_closed',
      meta: baseMeta,
    };
  }

  if (exchange === 'kis' && existingReason.includes('현재가 조회 실패')) {
    return {
      reason: existingReason,
      code: 'quote_lookup_failed',
      meta: baseMeta,
    };
  }

  if (
    exchange === 'kis_overseas'
    && (existingReason.includes('[90000000]') || existingReason.includes('모의투자에서는 해당업무가 제공되지 않습니다'))
  ) {
    return {
      reason: existingReason,
      code: 'mock_operation_unsupported',
      meta: baseMeta,
    };
  }

  return null;
}

export async function backfillSignalBlockReasons({ dryRun = false, days = 30 } = {}) {
  await db.initSchema();
  const safeDays = Number.isFinite(Number(days)) ? Math.max(1, Math.floor(Number(days))) : 30;

  const rows = await db.query(`
    SELECT id, symbol, exchange, action, amount_usdt, status, block_reason, block_code, block_meta, created_at
    FROM investment.signals
    WHERE created_at > now() - interval '${safeDays} days'
      AND status IN ('failed', 'rejected', 'expired')
      AND (
        block_reason IS NULL OR block_reason = ''
        OR block_code IS NULL OR block_code = ''
        OR block_meta IS NULL
      )
    ORDER BY created_at DESC
  `);

  const updates = rows.map(row => ({
    id: row.id,
    exchange: row.exchange,
    symbol: row.symbol,
    ...inferBlockInfo(row),
  }));

  if (!dryRun) {
    for (const item of updates) {
      await db.updateSignalBlock(item.id, {
        reason: item.reason,
        code: item.code,
        meta: item.meta,
      });
    }
  }

  return {
    days,
    dryRun,
    updated: updates.length,
    items: updates,
  };
}

export async function reclassifySignalBlockReasons({ dryRun = false, days = 30 } = {}) {
  await db.initSchema();
  const safeDays = Number.isFinite(Number(days)) ? Math.max(1, Math.floor(Number(days))) : 30;

  const rows = await db.query(`
    SELECT id, symbol, exchange, action, amount_usdt, status, block_reason, block_code, block_meta, created_at
    FROM investment.signals
    WHERE created_at > now() - interval '${safeDays} days'
      AND status IN ('failed', 'rejected', 'expired')
      AND exchange IN ('kis', 'kis_overseas')
      AND COALESCE(block_reason, '') <> ''
      AND (
        COALESCE(block_code, '') = ''
        OR COALESCE(block_code, '') = 'domestic_order_rejected'
        OR COALESCE(block_code, '') = 'overseas_order_rejected'
        OR COALESCE(block_code, '') = 'legacy_executor_failed'
        OR COALESCE(block_code, '') = 'legacy_unclassified'
      )
    ORDER BY created_at DESC
  `);

  const updates = rows
    .map((row) => ({
      id: row.id,
      exchange: row.exchange,
      symbol: row.symbol,
      ...inferReclassifiedBlockInfo(row),
    }))
    .filter((item) => item.code);

  if (!dryRun) {
    for (const item of updates) {
      await db.updateSignalBlock(item.id, {
        reason: item.reason,
        code: item.code,
        meta: item.meta,
      });
    }
  }

  return {
    days: safeDays,
    dryRun,
    updated: updates.length,
    items: updates,
  };
}

async function main() {
  const dryRunArg = process.argv.includes('--dry-run');
  const daysArg = process.argv.find(arg => arg.startsWith('--days='));
  const days = daysArg ? parseInt(daysArg.split('=')[1], 10) : 30;
  const mode = process.argv.find(arg => arg.startsWith('--mode='))?.split('=')[1] || 'missing';
  const result = mode === 'reclassify'
    ? await reclassifySignalBlockReasons({ dryRun: dryRunArg, days })
    : await backfillSignalBlockReasons({ dryRun: dryRunArg, days });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    const detail = err?.errors?.length
      ? ` | ${err.errors.map(inner => inner?.message || String(inner)).join(' | ')}`
      : '';
    console.error(`❌ signal block_reason 백필 실패: ${err?.message || String(err)}${detail}`);
    process.exit(1);
  });
}
