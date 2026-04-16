/**
 * ska-failure-reporter.ts
 *
 * Node.js 에이전트(앤디/지미)의 에러를 ska.failure_cases DB에 기록.
 * Elixir FailureTracker가 이 테이블을 폴링해서 자동 복구를 트리거함.
 *
 * 비동기 fire-and-forget — 리포트 실패가 모니터 동작에 영향 없음.
 */

const pgPool = require('../../../packages/core/lib/pg-pool');

export type SkaErrorType =
  | 'network_error'
  | 'selector_broken'
  | 'timeout'
  | 'auth_expired'
  | 'unknown';

export interface SkaFailure {
  agent: string;
  message: string;
  errorType?: SkaErrorType;
  target?: string;
}

/** 에러 메시지를 보고 자동 분류 */
export function classifyError(message: string): SkaErrorType {
  const msg = String(message || '');

  if (/detached\s*Frame|selector|not\s*found|No\s*node\s*found|waitForSelector/i.test(msg)) {
    return 'selector_broken';
  }
  if (/ECONNREFUSED|ECONNRESET|ERR_NETWORK|fetch\s*failed|network/i.test(msg)) {
    return 'network_error';
  }
  if (/timeout|TimeoutError|Navigation\s*timeout|Waiting\s*failed/i.test(msg)) {
    return 'timeout';
  }
  if (/401|Unauthorized|session\s*expired|로그인|login\s*required|Cookie\s*expired/i.test(msg)) {
    return 'auth_expired';
  }
  return 'unknown';
}

/** ska.failure_cases DB에 upsert (비동기, fire-and-forget) */
export function reportFailure(failure: SkaFailure): void {
  const errorType = failure.errorType ?? classifyError(failure.message);
  const agent = failure.agent || 'unknown';
  const message = String(failure.message || '').slice(0, 500);

  // 비동기로 실행 — 실패해도 무시
  setImmediate(async () => {
    try {
      await pgPool.run('ska', `
        INSERT INTO ska.failure_cases
          (error_type, error_message, agent, count, first_seen, last_seen)
        VALUES ($1, $2, $3, 1, NOW(), NOW())
        ON CONFLICT (agent, error_type, md5(error_message))
        DO UPDATE SET
          count     = ska.failure_cases.count + 1,
          last_seen = NOW()
      `, [errorType, message, agent]);
    } catch (_err) {
      // 리포트 실패는 조용히 무시 (모니터 동작 중단 방지)
    }
  });
}

/** reportFailure를 error-tracker의 onReport 콜백 형식으로 래핑 */
export function createSkaReporter(agent: string) {
  return (message: string, count: number) => {
    // count가 1 이상이면 무조건 기록 (threshold 이전도 포함)
    reportFailure({ agent, message });
  };
}
