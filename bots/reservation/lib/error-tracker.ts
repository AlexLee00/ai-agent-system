import fs from 'fs';
import path from 'path';
import { publishReservationAlert } from './alert-client';
import { log } from './utils';

const DEFAULT_THRESHOLD = 3;
const ESCALATION_INTERVAL = 10;
const PERSIST_DIR = '/tmp';

export interface ErrorTrackerOptions {
  label?: string;
  threshold?: number;
  persist?: boolean;
  /** 에러 발생마다 호출되는 콜백 (FailureTracker 연동용) */
  onReport?: (message: string, count: number) => void;
}

export interface ErrorTracker {
  fail(error: Error | string): void;
  success(): void;
  getCount(): number;
  reset(): void;
}

export function createErrorTracker({
  label = 'unknown',
  threshold = DEFAULT_THRESHOLD,
  persist = false,
  onReport,
}: ErrorTrackerOptions = {}): ErrorTracker {
  const persistPath = path.join(PERSIST_DIR, `ska-${label}-errors.json`);

  let count = 0;
  if (persist) {
    try {
      const saved = JSON.parse(fs.readFileSync(persistPath, 'utf-8')) as { count?: number };
      count = saved.count || 0;
      if (count > 0) log(`[${label}] 이전 연속 오류 카운터 복원: ${count}회`);
    } catch {
      // ignore
    }
  }

  function saveCount(): void {
    if (!persist) return;
    try {
      fs.writeFileSync(persistPath, JSON.stringify({ count, updatedAt: new Date().toISOString() }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`⚠️ [${label}] 오류 카운터 저장 실패: ${message}`);
    }
  }

  function clearSaved(): void {
    if (!persist) return;
    try {
      fs.unlinkSync(persistPath);
    } catch {
      // ignore
    }
  }

  function fail(error: Error | string): void {
    count += 1;
    const message = (error instanceof Error ? error.message : String(error)) || '알 수 없는 오류';
    log(`⚠️ [${label}] 연속 오류 ${count}회: ${message}`);
    saveCount();

    // FailureTracker 연동 콜백 (ska-failure-reporter 등)
    if (onReport) {
      try { onReport(message, count); } catch (_) {}
    }

    const isFirstAlert = count === threshold;
    const isEscalation = count > threshold && (count - threshold) % ESCALATION_INTERVAL === 0;

    if (isFirstAlert || isEscalation) {
      const lines = [
        `🚨 연속 오류 감지 — ${label}`,
        `연속 실패: ${count}회`,
        `최근 오류: ${message.slice(0, 150)}`,
        `시각: ${new Date().toLocaleTimeString('ko-KR')}`,
      ];
      if (count > threshold) lines.push(`(${count - threshold}회 추가 지속 — 수동 확인 권장)`);
      void publishReservationAlert({
        from_bot: 'ska',
        event_type: 'alert',
        alert_level: 3,
        message: lines.join('\n'),
      });
    }
  }

  function success(): void {
    if (count > 0) {
      log(`✅ [${label}] 오류 복구 (연속 ${count}회 후 성공 → 카운터 초기화)`);
      count = 0;
      clearSaved();
    }
  }

  function getCount(): number {
    return count;
  }

  function reset(): void {
    count = 0;
    clearSaved();
  }

  return { fail, success, getCount, reset };
}
