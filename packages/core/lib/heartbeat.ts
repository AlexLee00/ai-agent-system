const stateBus = require('../../../bots/reservation/lib/state-bus') as {
  updateAgentState: (teamLeadId: string, status: string, task?: string | null, metadata?: unknown) => Promise<unknown>;
  getUnprocessedEvents: (teamLeadId: string, limit: number) => Promise<Array<{
    id: number;
    event_type?: string;
    priority?: string;
    payload?: string | null;
    from_agent?: string | null;
    [key: string]: unknown;
  }>>;
  markEventProcessed: (id: number) => Promise<unknown>;
};

type NotifyFn = ((msg: string) => Promise<void>) | null;

type HeartbeatEvent = {
  id: number;
  event_type?: string;
  priority?: string;
  payload?: string | null;
  from_agent?: string | null;
  parsedPayload?: unknown;
  [key: string]: unknown;
};

type HeartbeatCheckResult = {
  ok?: boolean;
  issues?: string[];
};

type HeartbeatOptions = {
  onEvent?: (event: HeartbeatEvent) => Promise<void>;
  onCheck?: () => Promise<HeartbeatCheckResult | null | undefined>;
  eventLimit?: number;
  verbose?: boolean;
};

const _timers: Record<string, NodeJS.Timeout> = {};
let _notifyFn: NotifyFn = null;

function setNotifyFn(fn: NotifyFn): void {
  _notifyFn = fn;
}

async function _notify(msg: string): Promise<void> {
  if (_notifyFn) {
    try {
      await _notifyFn(msg);
    } catch (error) {
      console.error(`[하트비트] 텔레그램 알림 실패: ${(error as Error).message}`);
    }
  } else {
    console.warn(`[하트비트 알림] ${msg}`);
  }
}

async function heartbeat(teamLeadId: string, opts: HeartbeatOptions = {}): Promise<{ eventsProcessed: number; issues: string[] }> {
  const { onEvent, onCheck, eventLimit = 10, verbose = false } = opts;
  const now = new Date().toISOString();
  const issues: string[] = [];

  try {
    await stateBus.updateAgentState(teamLeadId, 'idle', null, null);
    if (verbose) console.log(`  ✅ [하트비트:${teamLeadId}] agent_state 갱신 (${now})`);
  } catch (error) {
    const msg = `agent_state 갱신 실패: ${(error as Error).message}`;
    issues.push(msg);
    console.error(`  ❌ [하트비트:${teamLeadId}] ${msg}`);
  }

  let eventsProcessed = 0;
  try {
    const events = await stateBus.getUnprocessedEvents(teamLeadId, eventLimit);
    if (events.length > 0) {
      if (verbose || events.some((event) => event.priority === 'critical' || event.priority === 'high')) {
        console.log(`  📥 [하트비트:${teamLeadId}] 미처리 이벤트 ${events.length}건`);
      }

      for (const ev of events) {
        try {
          let payload: unknown = null;
          try {
            payload = JSON.parse(ev.payload || 'null');
          } catch {}
          const enriched: HeartbeatEvent = { ...ev, parsedPayload: payload };

          if (onEvent) {
            await onEvent(enriched);
          } else {
            console.log(`  📨 [하트비트:${teamLeadId}] 이벤트 #${ev.id} [${ev.event_type}/${ev.priority}] from ${ev.from_agent}`);
          }

          await stateBus.markEventProcessed(ev.id);
          eventsProcessed++;
        } catch (error) {
          const msg = `이벤트 #${ev.id} 처리 실패: ${(error as Error).message}`;
          issues.push(msg);
          console.error(`  ⚠️  [하트비트:${teamLeadId}] ${msg}`);
        }
      }
    } else if (verbose) {
      console.log(`  💤 [하트비트:${teamLeadId}] 미처리 이벤트 없음`);
    }
  } catch (error) {
    const msg = `이벤트 폴링 실패: ${(error as Error).message}`;
    issues.push(msg);
    console.error(`  ❌ [하트비트:${teamLeadId}] ${msg}`);
  }

  if (onCheck) {
    try {
      const checkResult = await onCheck();
      if (checkResult?.issues?.length) {
        issues.push(...checkResult.issues);
        for (const issue of checkResult.issues) {
          console.warn(`  ⚠️  [하트비트:${teamLeadId}] ${issue}`);
        }
      }
    } catch (error) {
      const msg = `추가 점검 실패: ${(error as Error).message}`;
      issues.push(msg);
      console.error(`  ❌ [하트비트:${teamLeadId}] ${msg}`);
    }
  }

  if (issues.length > 0) {
    const alertMsg = [
      `⚠️ [${teamLeadId}] 하트비트 이상 감지 (${issues.length}건)`,
      ...issues.map((issue, index) => `  ${index + 1}. ${issue}`),
    ].join('\n');
    await _notify(alertMsg);
  }

  return { eventsProcessed, issues };
}

function startHeartbeat(teamLeadId: string, intervalMs = 300_000, opts: HeartbeatOptions = {}): { stop: () => void } {
  if (_timers[teamLeadId]) {
    console.warn(`[하트비트] ${teamLeadId} 인터벌 이미 실행 중 — 기존 정지 후 재시작`);
    stopHeartbeat(teamLeadId);
  }

  console.log(`🔔 [하트비트] ${teamLeadId} 시작 (${intervalMs / 1000}초 주기)`);

  heartbeat(teamLeadId, opts).catch((error: Error) =>
    console.error(`[하트비트:${teamLeadId}] 초기 실행 오류: ${error.message}`)
  );

  _timers[teamLeadId] = setInterval(() => {
    heartbeat(teamLeadId, opts).catch((error: Error) =>
      console.error(`[하트비트:${teamLeadId}] 오류: ${error.message}`)
    );
  }, intervalMs);

  return {
    stop: () => stopHeartbeat(teamLeadId),
  };
}

function stopHeartbeat(teamLeadId: string): void {
  if (_timers[teamLeadId]) {
    clearInterval(_timers[teamLeadId]);
    delete _timers[teamLeadId];
    console.log(`🔕 [하트비트] ${teamLeadId} 정지`);
  }
}

function getActiveHeartbeats(): string[] {
  return Object.keys(_timers);
}

export = {
  setNotifyFn,
  heartbeat,
  startHeartbeat,
  stopHeartbeat,
  getActiveHeartbeats,
};
