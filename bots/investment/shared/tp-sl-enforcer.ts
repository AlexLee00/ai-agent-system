// @ts-nocheck
/**
 * shared/tp-sl-enforcer.ts — Phase G: TP/SL 강제 설정 가드
 *
 * 분석 결과: tp_sl_set=false 승률 17.5% vs tp_sl_set=true 승률 39.0% (2.2배)
 * 80%의 거래가 SL 없이 진입 → 이 모듈로 강제.
 *
 * Kill Switch:
 *   LUNA_TP_SL_ENFORCE=false → 비활성 (기본: true)
 */

import { calculateAtrTpSl } from './tp-sl-auto-setter.ts';

// ── 상수 ─────────────────────────────────────────────────

const DEFAULT_RR = 2;
const DEFAULT_ATR_STOP_MULTIPLE = 1.0;

// ── 타입 ─────────────────────────────────────────────────

export interface TpSlEnforcementInput {
  /** 현재 진입 가격 */
  entryPrice: number | null;
  /** 방향 'BUY' | 'SELL' */
  side?: string;
  /** ATR 값 (있으면 자동 계산) */
  atr?: number | null;
  /** 이미 계획된 SL 가격 */
  prePlannedSl?: number | null;
  /** 이미 계획된 TP 가격 */
  prePlannedTp?: number | null;
  /** tp_sl_set 플래그 (이미 설정됐으면 통과) */
  tpSlSet?: boolean;
  /** 시장 구분 */
  market?: string;
  /** 심볼 (로그용) */
  symbol?: string;
}

export interface TpSlEnforcementResult {
  /** true: 진입 허용 (TP/SL 계획 있음) */
  allowed: boolean;
  /** TP/SL이 이미 있었는지 여부 */
  alreadySet: boolean;
  /** ATR 계산으로 새로 추가된 TP/SL */
  computed: { takeProfit: number | null; stopLoss: number | null } | null;
  /** 차단 이유 (allowed=false 시) */
  blockReason: string | null;
  /** 권고 사항 메시지 */
  warningMessage: string | null;
}

// ── 내부 유틸 ─────────────────────────────────────────────

function isEnabled(): boolean {
  const val = process.env.LUNA_TP_SL_ENFORCE;
  if (val === 'false' || val === '0') return false;
  return true;
}

function hasTpSl(input: TpSlEnforcementInput): boolean {
  return (
    input.tpSlSet === true
    || (input.prePlannedSl != null && Number(input.prePlannedSl) > 0)
    || (input.prePlannedTp != null && Number(input.prePlannedTp) > 0)
  );
}

// ── 공개 API ─────────────────────────────────────────────

/**
 * BUY/진입 전에 TP/SL 계획 여부를 확인.
 * 없으면 ATR 기반 계산 시도, 그래도 없으면 차단.
 */
export function enforceTpSlRequirement(
  input: TpSlEnforcementInput,
  opts: { rr?: number; atrStopMultiple?: number } = {},
): TpSlEnforcementResult {
  if (!isEnabled()) {
    return {
      allowed: true,
      alreadySet: true,
      computed: null,
      blockReason: null,
      warningMessage: null,
    };
  }

  // 이미 TP/SL 설정된 경우 → 즉시 허용
  if (hasTpSl(input)) {
    return {
      allowed: true,
      alreadySet: true,
      computed: null,
      blockReason: null,
      warningMessage: null,
    };
  }

  const ep = Number(input.entryPrice);
  const atr = Number(input.atr);
  const side = String(input.side || 'BUY').toUpperCase();

  // ATR 기반 자동 계산 시도
  if (ep > 0 && atr > 0) {
    const calc = calculateAtrTpSl({
      entryPrice: ep,
      atr,
      side,
      rr: opts.rr ?? DEFAULT_RR,
      atrStopMultiple: opts.atrStopMultiple ?? DEFAULT_ATR_STOP_MULTIPLE,
    });

    if (calc.ok && calc.stopLoss != null) {
      const sym = input.symbol ? `[${input.symbol}]` : '';
      console.log(`[tp-sl-enforcer]${sym} ATR 자동계산 — SL=${calc.stopLoss} TP=${calc.takeProfit}`);
      return {
        allowed: true,
        alreadySet: false,
        computed: { takeProfit: calc.takeProfit, stopLoss: calc.stopLoss },
        blockReason: null,
        warningMessage: `ATR 자동 TP/SL 계산됨: SL=${calc.stopLoss}, TP=${calc.takeProfit}`,
      };
    }
  }

  // ATR도 없고 TP/SL도 없음 → 차단
  const sym = input.symbol ? ` (${input.symbol})` : '';
  const reason = ep <= 0
    ? `entry_price 무효 (${input.entryPrice})`
    : atr <= 0
      ? 'ATR 없음 — TP/SL 계획 불가'
      : 'TP/SL 계획 없음';

  console.warn(`[tp-sl-enforcer] 진입 차단${sym}: ${reason}`);

  return {
    allowed: false,
    alreadySet: false,
    computed: null,
    blockReason: `tp_sl_required_not_met: ${reason}`,
    warningMessage: null,
  };
}

/**
 * 진입 candidate에서 TP/SL 상태 요약 반환.
 * luna-constitution 등에서 빠른 점검용.
 */
export function getTpSlStatus(candidate: Record<string, unknown>): {
  tpSlSet: boolean;
  hasSlPrice: boolean;
  hasTpPrice: boolean;
} {
  const tpSlSet = candidate.tp_sl_set === true
    || candidate.block_meta?.tp_sl_set === true
    || candidate.block_meta?.tpSlSet === true;

  const hasSlPrice = candidate.sl_price != null
    || candidate.stop_loss != null
    || candidate.stopLoss != null
    || candidate.block_meta?.sl_price != null;

  const hasTpPrice = candidate.tp_price != null
    || candidate.take_profit != null
    || candidate.takeProfit != null
    || candidate.block_meta?.tp_price != null;

  return { tpSlSet, hasSlPrice, hasTpPrice };
}
