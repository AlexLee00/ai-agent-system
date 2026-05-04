// @ts-nocheck
/**
 * shared/reflexion-guard.ts — Phase G: Reflexion 자동 회피 가드
 *
 * 기능:
 *   1. 진입 thesis 생성 직전 — 유사 거래 실패 회고 자동 조회 → confidence 차감
 *   2. LLM 호출 실패 → 실패 패턴 기록 → 다음 호출 시 provider 회피
 *   3. 동일 프롬프트 패턴 반복 실패 → 자동 reformulation 권고
 *
 * Kill Switch:
 *   LUNA_AGENT_REFLEXION_AUTO_AVOID=false → 전체 비활성
 */

import * as crypto from 'crypto';
import { isAgentMemoryFeatureEnabled } from './agent-memory-runtime.ts';
import * as db from './db.ts';

const REFLEXION_ENABLED = () => isAgentMemoryFeatureEnabled('reflexionAutoAvoidEnabled');

function parseSymbolBlacklist(raw = ''): Set<string> {
  return new Set(
    String(raw || '')
      .split(',')
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean),
  );
}

function normalizeMarketForBlacklist(market = '') {
  const value = String(market || '').trim().toLowerCase();
  if (value === 'binance') return 'crypto';
  if (value === 'kis') return 'domestic';
  if (value === 'kis_overseas') return 'overseas';
  return value || 'unknown';
}

export function checkSymbolBlacklist(symbol: string, market: string, env = process.env): {
  blocked: boolean;
  blockReason: string | null;
  source: string | null;
} {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  const normalizedMarket = normalizeMarketForBlacklist(market).toUpperCase();
  if (!normalizedSymbol) return { blocked: false, blockReason: null, source: null };

  const list = parseSymbolBlacklist(env.LUNA_PRE_ENTRY_SYMBOL_BLACKLIST || env.LUNA_SYMBOL_BLACKLIST || '');
  const keys = [
    normalizedSymbol,
    `${normalizedMarket}:${normalizedSymbol}`,
  ];
  const matched = keys.find((key) => list.has(key));
  if (!matched) return { blocked: false, blockReason: null, source: null };
  return {
    blocked: true,
    blockReason: `[symbol-blacklist] ${normalizedSymbol} blocked by pre_entry blacklist (${matched})`,
    source: 'pre_entry/symbol_blacklist',
  };
}

/** 실패 회고 검색 결과 */
export interface FailureReflexion {
  tradeId: number;
  hindsight: string;
  avoidPattern: {
    symbolPattern?: string;
    avoidAction?: string;
    reason?: string;
    evidence?: unknown;
  };
  createdAt: Date;
}

/** 진입 신호 평가 결과 */
export interface ReflexionGuardResult {
  confidenceDelta: number;        // 음수: 차감, 0: 영향 없음
  blockedByReflexion: boolean;    // true: 진입 완전 차단
  relevantFailures: FailureReflexion[];
  warningMessage: string | null;
}

/**
 * 유사 실패 reflexion 조회 → confidence 차감 계산.
 * thesis 생성 직전에 호출.
 */
export async function checkReflexionBeforeEntry(
  symbol: string,
  market: string,
  proposedAction: 'LONG' | 'SHORT',
  context: { sector?: string; pattern?: string } = {},
): Promise<ReflexionGuardResult> {
  if (!REFLEXION_ENABLED()) {
    return { confidenceDelta: 0, blockedByReflexion: false, relevantFailures: [], warningMessage: null };
  }

  try {
    // 1. luna_failure_reflexions에서 유사 실패 조회
    const rows = await db.query(`
      SELECT
        fr.trade_id,
        fr.hindsight,
        fr.avoid_pattern,
        fr.created_at
      FROM investment.luna_failure_reflexions fr
      WHERE
        (
          fr.avoid_pattern->>'symbol_pattern' IS NOT NULL
          AND $1 ILIKE '%' || (fr.avoid_pattern->>'symbol_pattern') || '%'
        )
        OR (
          fr.avoid_pattern->>'avoid_action' = $2
        )
      ORDER BY fr.created_at DESC
      LIMIT 5
    `, [symbol, proposedAction]);

    const failures: FailureReflexion[] = (rows || []).map((row: any) => ({
      tradeId: row.trade_id,
      hindsight: row.hindsight,
      avoidPattern: row.avoid_pattern || {},
      createdAt: row.created_at,
    }));

    if (failures.length === 0) {
      return { confidenceDelta: 0, blockedByReflexion: false, relevantFailures: [], warningMessage: null };
    }

    // 2. 실패 건수 × 차감 계산
    const delta = -(failures.length * 0.10);         // 건당 -0.10
    const blocked = failures.length >= 3;             // 3건 이상 → 차단

    const patternSummary = failures
      .map(f => f.avoidPattern.reason || f.hindsight || '유사 실패')
      .slice(0, 2)
      .join('; ');

    const warning = `[reflexion] ${symbol} ${proposedAction}: 유사 실패 ${failures.length}건 — ${patternSummary}`;
    console.warn(warning);

    return {
      confidenceDelta: delta,
      blockedByReflexion: blocked,
      relevantFailures: failures,
      warningMessage: warning,
    };
  } catch (err) {
    console.error('[reflexion-guard] 조회 실패:', err);
    return { confidenceDelta: 0, blockedByReflexion: false, relevantFailures: [], warningMessage: null };
  }
}

/**
 * LLM 호출 실패 기록.
 * callLLMWithHub 실패 시 호출.
 */
export async function recordLLMFailure(
  agentName: string,
  provider: string,
  prompt: string,
  errorType: 'timeout' | 'rate_limit' | 'parse_fail' | 'bad_response' | 'unknown',
  market?: string,
  taskType?: string,
): Promise<void> {
  if (!REFLEXION_ENABLED()) return;

  try {
    const promptHash = crypto.createHash('sha256').update(prompt.slice(0, 500)).digest('hex').slice(0, 16);

    await db.run(`
      INSERT INTO investment.llm_failure_reflexions
        (agent_name, market, task_type, provider, error_type, prompt_hash, failure_count, last_failed_at)
      VALUES ($1, $2, $3, $4, $5, $6, 1, NOW())
      ON CONFLICT (agent_name, prompt_hash, provider)
      DO UPDATE SET
        failure_count  = investment.llm_failure_reflexions.failure_count + 1,
        last_failed_at = NOW(),
        error_type     = EXCLUDED.error_type
    `, [agentName, market || null, taskType || null, provider, errorType, promptHash]);
  } catch (err) {
    // DB 저장 실패는 운영 중단 없이 무시
    console.warn('[reflexion-guard] LLM 실패 기록 오류:', err);
  }
}

/**
 * 특정 에이전트에서 회피할 provider 목록 반환.
 * 최근 7일 내 3회 이상 실패한 provider 제외.
 */
export async function getAvoidProviders(agentName: string): Promise<string[]> {
  if (!REFLEXION_ENABLED()) return [];

  try {
    const rows = await db.query(`
      SELECT provider
      FROM investment.llm_failure_reflexions
      WHERE
        agent_name = $1
        AND last_failed_at > NOW() - INTERVAL '7 days'
        AND failure_count >= 3
      ORDER BY failure_count DESC
      LIMIT 3
    `, [agentName]);

    return (rows || []).map((r: any) => r.provider);
  } catch {
    return [];
  }
}

/**
 * 실패 reflexion을 프롬프트 prefix로 포맷.
 * agent-memory-orchestrator에서 호출.
 */
export function formatFailureReflexions(failures: FailureReflexion[]): string {
  if (failures.length === 0) return '';

  const items = failures.slice(0, 2).map(f => {
    const pattern = f.avoidPattern.reason || f.hindsight || '';
    return `- [실패 회고] ${pattern}`;
  });

  return `## 유사 실패 사례 (Reflexion)\n${items.join('\n')}\n→ 위 패턴과 유사한 진입은 신중히 검토하세요.\n`;
}

// ────────────────────────────────────────────────────────────
// 보강 4: Per-Symbol Loss Streak 회피 (분석: TAO 31건 승률 6.5%)
// ────────────────────────────────────────────────────────────

export interface SymbolLossStreakResult {
  /** 연속 손실 건수 */
  lossStreak: number;
  /** 최근 N일 내 손실 비율 (0~1) */
  recentLossRate: number;
  /** 쿨다운 적용 여부 */
  inCooldown: boolean;
  /** 쿨다운 종료 예정 시각 (Unix ms) */
  cooldownUntil: number | null;
  /** 차단 사유 */
  blockReason: string | null;
}

/**
 * 종목별 연속 손실 패턴 확인.
 * 연속 3회 손실 → 7일 쿨다운 (진입 차단).
 * 진입 신호 평가 전에 호출.
 */
export async function checkSymbolLossStreak(
  symbol: string,
  market: string,
): Promise<SymbolLossStreakResult> {
  const blacklist = checkSymbolBlacklist(symbol, market);
  if (blacklist.blocked) {
    return {
      lossStreak: 0,
      recentLossRate: 1,
      inCooldown: true,
      cooldownUntil: null,
      blockReason: blacklist.blockReason,
    };
  }

  if (!REFLEXION_ENABLED()) {
    return { lossStreak: 0, recentLossRate: 0, inCooldown: false, cooldownUntil: null, blockReason: null };
  }

  try {
    // 최근 30일 내 해당 종목 closed 거래 이력 조회
    const rows = await db.query(`
      SELECT
        id,
        pnl_amount,
        pnl_percent,
        pnl_net,
        exit_time,
        created_at
      FROM investment.trade_journal
      WHERE
        symbol = $1
        AND market = $2
        AND (status = 'closed' OR exit_time IS NOT NULL)
        AND created_at >= NOW() - INTERVAL '30 days'
      ORDER BY COALESCE(exit_time, created_at) DESC
      LIMIT 20
    `, [symbol, market]);

    if (!rows || rows.length === 0) {
      return { lossStreak: 0, recentLossRate: 0, inCooldown: false, cooldownUntil: null, blockReason: null };
    }

    // 연속 손실 계산 (최신 → 오래된 순)
    let streak = 0;
    for (const row of rows) {
      const pnl = Number(row.pnl_net ?? row.pnl_amount ?? 0);
      if (pnl < 0) {
        streak++;
      } else {
        break;
      }
    }

    // 최근 10건 손실 비율
    const recentRows = rows.slice(0, 10);
    const losses = recentRows.filter(r => Number(r.pnl_net ?? r.pnl_amount ?? 0) < 0).length;
    const recentLossRate = recentRows.length > 0 ? losses / recentRows.length : 0;

    // 쿨다운 판정: 연속 3회+ 손실
    if (streak >= 3) {
      // 가장 최근 손실 종료 시각 기준 7일 쿨다운
      const latestExitMs = rows[0]?.exit_time != null
        ? Number(rows[0].exit_time)
        : new Date(rows[0].created_at).getTime();
      const cooldownUntil = latestExitMs + 7 * 24 * 60 * 60 * 1000;
      const inCooldown = Date.now() < cooldownUntil;

      if (inCooldown) {
        const until = new Date(cooldownUntil).toISOString().slice(0, 10);
        const reason = `[symbol-reflexion] ${symbol} 연속 ${streak}회 손실 → ${until}까지 쿨다운`;
        console.warn(reason);
        return { lossStreak: streak, recentLossRate, inCooldown: true, cooldownUntil, blockReason: reason };
      }
    }

    return { lossStreak: streak, recentLossRate, inCooldown: false, cooldownUntil: null, blockReason: null };
  } catch (err) {
    console.error('[reflexion-guard] symbol loss streak 조회 실패:', err);
    return { lossStreak: 0, recentLossRate: 0, inCooldown: false, cooldownUntil: null, blockReason: null };
  }
}
