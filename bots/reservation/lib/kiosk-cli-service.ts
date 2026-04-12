type Logger = (message: string) => void;

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
    return runBlockSlotOnly({ entry, wsEndpoint });
  }

  async function unblockSlotOnly(entry: Record<string, any>) {
    const wsEndpoint = readWsEndpoint();
    return runUnblockSlotOnly({ entry, wsEndpoint });
  }

  async function auditToday(dateOverride: string | null = null) {
    const wsEndpoint = readWsEndpoint();
    return runAuditToday({ dateOverride, wsEndpoint });
  }

  async function verifySlotOnly(entry: Record<string, any>) {
    const wsEndpoint = readWsEndpoint();
    return runVerifySlotOnly({ entry, wsEndpoint });
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
