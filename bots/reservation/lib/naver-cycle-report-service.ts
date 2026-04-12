type Logger = (message: string) => void;
type PublishAlertFn = (payload: Record<string, any>) => Promise<any> | any;
type GetTodayStatsFn = (date: string) => Promise<any>;
type UpdateAgentStateFn = (agent: string, status: string) => Promise<any>;
type WriteHeartbeatFn = (agent: string, status: string, payload?: Record<string, any>) => Promise<any>;
type RecordHeartbeatFn = (payload: Record<string, any>) => void;

export type CreateNaverCycleReportServiceDeps = {
  log: Logger;
  publishReservationAlert: PublishAlertFn;
  getTodayStats: GetTodayStatsFn;
  updateAgentState: UpdateAgentStateFn;
  writeHeartbeat: WriteHeartbeatFn;
  recordHeartbeat: RecordHeartbeatFn;
};

export function createNaverCycleReportService(deps: CreateNaverCycleReportServiceDeps) {
  const {
    log,
    publishReservationAlert,
    getTodayStats,
    updateAgentState,
    writeHeartbeat,
    recordHeartbeat,
  } = deps;

  async function handlePeriodicReports({
    startTime,
    checkCount,
    currentConfirmedCount,
    cancelledCount,
    lastHeartbeatTime,
    heartbeatIntervalMs,
    lastDailyReportDate,
    dailyStats,
  }: {
    startTime: number;
    checkCount: number;
    currentConfirmedCount: number;
    cancelledCount: number;
    lastHeartbeatTime: number;
    heartbeatIntervalMs: number;
    lastDailyReportDate: string;
    dailyStats: Record<string, any>;
  }): Promise<{ lastHeartbeatTime: number; lastDailyReportDate: string; dailyStats: Record<string, any> }> {
    let nextHeartbeatTime = lastHeartbeatTime;
    let nextDailyReportDate = lastDailyReportDate;
    let nextDailyStats = dailyStats;

    if (process.env.SKA_ENABLE_HEARTBEAT_ALERTS === '1' && Date.now() - lastHeartbeatTime >= heartbeatIntervalMs) {
      const hour = parseInt(new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', hour12: false }).replace(/\D/g, ''), 10);
      if (hour >= 9 && hour < 22) {
        const uptimeMinutes = Math.floor((Date.now() - startTime) / 60000);
        const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
        const todayStats = await getTodayStats(todayStr);
        const message =
          `✅ 스카 정상 운영 중\n\n확인 #${checkCount} | 업타임 ${uptimeMinutes}분\n\n` +
          `📋 오늘 예약 (${todayStr})\n` +
          `네이버: ${currentConfirmedCount}건 확정 | ${cancelledCount}건 취소\n` +
          `키오스크: ${todayStats.kioskTotal}건\n` +
          `합계: ${todayStats.total}건\n\n` +
          '다음 heartbeat: 1시간 후';
        await Promise.resolve(publishReservationAlert({
          from_bot: 'andy',
          event_type: 'heartbeat',
          alert_level: 1,
          message,
        }));
        log(`💓 Heartbeat 전송 (확인 #${checkCount}, 업타임 ${uptimeMinutes}분)`);
        nextHeartbeatTime = Date.now();
      }

      const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
      const fullHour = parseInt(new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', hour12: false }).replace(/\D/g, ''), 10);
      if (process.env.SKA_ENABLE_NAVER_DAILY_REPORT === '1' && fullHour >= 22 && lastDailyReportDate !== dateStr) {
        const dayMsg =
          `📊 스카 일일 마감 요약 (${dateStr})\n\n` +
          `✅ 신규 등록 완료: ${dailyStats.completed}건\n` +
          `🚫 취소 처리: ${dailyStats.cancelled}건\n` +
          `⚠️ 등록 실패: ${dailyStats.failed}건\n` +
          `🔍 감지 총계: ${dailyStats.detected}건`;
        await Promise.resolve(publishReservationAlert({
          from_bot: 'andy',
          event_type: 'report',
          alert_level: 1,
          message: dayMsg,
        }));
        log(`📊 일일 마감 요약 전송: 등록${dailyStats.completed} 취소${dailyStats.cancelled} 실패${dailyStats.failed} 감지${dailyStats.detected}`);
        nextDailyReportDate = dateStr;
        nextDailyStats = { date: dateStr, detected: 0, completed: 0, cancelled: 0, failed: 0 };
      }
    }

    return {
      lastHeartbeatTime: nextHeartbeatTime,
      lastDailyReportDate: nextDailyReportDate,
      dailyStats: nextDailyStats,
    };
  }

  async function markCycleIdle(checkCount: number): Promise<void> {
    await updateAgentState('andy', 'idle');
    await writeHeartbeat('andy', 'ok', {
      cycle: checkCount,
      status: 'idle',
    }).catch(() => {});
    recordHeartbeat({ status: 'idle' });
  }

  async function markCycleError(checkCount: number, error: any): Promise<void> {
    recordHeartbeat({ status: 'error', error });
    await writeHeartbeat('andy', 'error', {
      cycle: checkCount,
      error: error?.message || String(error),
    }).catch(() => {});
  }

  return {
    handlePeriodicReports,
    markCycleIdle,
    markCycleError,
  };
}
