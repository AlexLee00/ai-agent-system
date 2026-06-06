type Logger = (message: string) => void;
const { splitKioskEntryForNaverBlocks } = require('./kiosk-monitor-helpers');

export type CreateKioskCliServiceDeps = {
  readWsEndpoint: () => string | null;
  runBlockSlotOnly: (args: { entry: Record<string, any>; wsEndpoint?: string | null }) => Promise<number>;
  runUnblockSlotOnly: (args: { entry: Record<string, any>; wsEndpoint?: string | null }) => Promise<number>;
  runAuditToday: (args: { dateOverride?: string | null; wsEndpoint?: string | null }) => Promise<any>;
  runVerifySlotOnly: (args: { entry: Record<string, any>; wsEndpoint?: string | null }) => Promise<number>;
  log: Logger;
  publishReservationAlert: (payload: Record<string, any>) => any;
};

export function createKioskCliService(deps: CreateKioskCliServiceDeps) {
  const {
    readWsEndpoint,
    runBlockSlotOnly,
    runUnblockSlotOnly,
    runAuditToday,
    runVerifySlotOnly,
    log,
    publishReservationAlert,
  } = deps;

  async function blockSlotOnly(entry: Record<string, any>) {
    const wsEndpoint = readWsEndpoint();
    const blockEntries = splitKioskEntryForNaverBlocks(entry);
    if (blockEntries.length > 1) {
      log(`↪ 날짜 넘어감 차단 분할: ${entry.date} ${entry.start}~${entry.end} → ${blockEntries.map((item: Record<string, any>) => `${item.date} ${item.start}~${item.end}`).join(', ')}`);
    }

    let exitCode = 0;
    for (const blockEntry of blockEntries) {
      const result = await runBlockSlotOnly({ entry: blockEntry, wsEndpoint });
      if (result !== 0) exitCode = result || 1;
    }
    return exitCode;
  }

  async function unblockSlotOnly(entry: Record<string, any>) {
    const wsEndpoint = readWsEndpoint();
    const unblockEntries = splitKioskEntryForNaverBlocks(entry);
    if (unblockEntries.length > 1) {
      log(`↪ 날짜 넘어감 해제 분할: ${entry.date} ${entry.start}~${entry.end} → ${unblockEntries.map((item: Record<string, any>) => `${item.date} ${item.start}~${item.end}`).join(', ')}`);
    }

    let exitCode = 0;
    for (const unblockEntry of unblockEntries) {
      const result = await runUnblockSlotOnly({ entry: unblockEntry, wsEndpoint });
      if (result !== 0) exitCode = result || 1;
    }
    return exitCode;
  }

  async function auditToday(dateOverride: string | null = null) {
    const wsEndpoint = readWsEndpoint();
    return runAuditToday({ dateOverride, wsEndpoint });
  }

  async function verifySlotOnly(entry: Record<string, any>) {
    const wsEndpoint = readWsEndpoint();
    const verifyEntries = splitKioskEntryForNaverBlocks(entry);
    if (verifyEntries.length > 1) {
      log(`↪ 날짜 넘어감 검증 분할: ${entry.date} ${entry.start}~${entry.end} → ${verifyEntries.map((item: Record<string, any>) => `${item.date} ${item.start}~${item.end}`).join(', ')}`);
    }

    let exitCode = 0;
    for (const verifyEntry of verifyEntries) {
      const result = await runVerifySlotOnly({ entry: verifyEntry, wsEndpoint });
      if (result !== 0) exitCode = result || 1;
    }
    return exitCode;
  }

  async function handleAuditTodayFailure(err: any) {
    log(`❌ audit-today 오류: ${err.message}`);
    publishReservationAlert({
      from_bot: 'jimmy',
      event_type: 'alert',
      alert_level: 3,
      message: `⚠️ [오늘 예약 검증] 실행 오류: ${err.message}`,
    });
  }

  return {
    blockSlotOnly,
    unblockSlotOnly,
    auditToday,
    verifySlotOnly,
    handleAuditTodayFailure,
  };
}
