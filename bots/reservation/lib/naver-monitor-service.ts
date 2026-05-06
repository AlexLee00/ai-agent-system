import fs from 'fs';
import path from 'path';

type Logger = (message: string) => void;
type PublishAlert = (payload: Record<string, any>) => unknown;
type FindReservation = (phone: string, date: string, start: string) => Promise<any>;
type ResolveAlertFn = (phone: string, date: string, start: string) => Promise<number>;
type ResolveAlertsByTitleFn = (title: string) => Promise<number>;
type GetUnresolvedAlertsFn = () => Promise<any[]>;
type AddAlertFn = (payload: Record<string, any>) => Promise<any>;
type UpdateAlertSentFn = (id: any, sentAt: string) => Promise<any>;
type PruneOldAlertsFn = () => Promise<number>;
type CleanupExpiredSeenFn = () => Promise<void>;
type IsTerminalReservationLikeFn = (reservation: any) => boolean;
type GetAlertLevelByTypeFn = (type: string) => number;
type MaskPhoneFn = (phone: string) => string;
type ToKstFn = (date: Date) => string;
type BuildMonitorAlertMessageFn = (options: Record<string, any>) => string;
type BuildUnresolvedAlertsSummaryFn = (actionable: Array<Record<string, any>>, nowMs?: number) => string;

export type CreateNaverMonitorServiceDeps = {
  workspace: string;
  log: Logger;
  publishReservationAlert: PublishAlert;
  findReservationByBooking: FindReservation;
  resolveAlert: ResolveAlertFn;
  resolveAlertsByTitle: ResolveAlertsByTitleFn;
  getUnresolvedAlerts: GetUnresolvedAlertsFn;
  addAlert: AddAlertFn;
  updateAlertSent: UpdateAlertSentFn;
  pruneOldAlerts: PruneOldAlertsFn;
  cleanupExpiredSeen: CleanupExpiredSeenFn;
  isTerminalReservationLike: IsTerminalReservationLikeFn;
  getAlertLevelByType: GetAlertLevelByTypeFn;
  maskPhone: MaskPhoneFn;
  toKst: ToKstFn;
  buildMonitorAlertMessage: BuildMonitorAlertMessageFn;
  buildUnresolvedAlertsSummary: BuildUnresolvedAlertsSummaryFn;
};

export function createNaverMonitorService(deps: CreateNaverMonitorServiceDeps) {
  const {
    workspace,
    log,
    publishReservationAlert,
    findReservationByBooking,
    resolveAlert,
    resolveAlertsByTitle,
    getUnresolvedAlerts,
    addAlert,
    updateAlertSent,
    pruneOldAlerts,
    cleanupExpiredSeen,
    isTerminalReservationLike,
    getAlertLevelByType,
    maskPhone,
    toKst,
    buildMonitorAlertMessage,
    buildUnresolvedAlertsSummary,
  } = deps;

  function isOperationalManualPendingAlert(alert: any): boolean {
    const title = String(alert?.title || '');
    const message = String(alert?.message || '');
    return title.includes('픽코 예약 등록됨, 결제 확인 필요')
      && message.includes('status: manual_pending');
  }

  async function cleanupOldAlerts(): Promise<void> {
    try {
      const removed = await pruneOldAlerts();
      if (removed > 0) log(`🧹 [정리] 알람 ${removed}건 삭제 (해결됨 48h, 미해결 7일 초과)`);
    } catch (error: any) {
      log(`⚠️ 알람 정리 실패: ${error?.message || String(error)}`);
    }
  }

  async function resolveAlertsByBooking(phone: string, date: string, start: string): Promise<void> {
    try {
      const count = await resolveAlert(phone, date, start);
      if (count > 0) log(`✅ [알림 해결] ${maskPhone(phone)} ${date} ${start} → 오류 알림 ${count}건 해결됨 마킹`);
    } catch (error: any) {
      log(`⚠️ 알림 해결 마킹 실패: ${error?.message || String(error)}`);
    }
  }

  async function resolveSystemAlertByTitle(title: string, reason?: string): Promise<void> {
    try {
      const count = await resolveAlertsByTitle(title);
      if (count > 0) log(`✅ [알림 해결] ${title} → ${count}건 해결됨 마킹${reason ? ` (${reason})` : ''}`);
    } catch (error: any) {
      log(`⚠️ 시스템 알림 해결 마킹 실패: ${error?.message || String(error)}`);
    }
  }

  async function reportUnresolvedAlerts(): Promise<void> {
    try {
      const unresolved = await getUnresolvedAlerts();
      const actionable: any[] = [];

      for (const alert of unresolved) {
        if (isOperationalManualPendingAlert(alert)) {
          await resolveSystemAlertByTitle(String(alert.title || '⚠️ 픽코 예약 등록됨, 결제 확인 필요'), 'manual_pending_operational_queue');
          continue;
        }

        if (!alert.phone || !alert.date || !alert.start_time) {
          actionable.push(alert);
          continue;
        }

        const reservation = await findReservationByBooking(alert.phone, alert.date, alert.start_time).catch(() => null);
        if (isTerminalReservationLike(reservation)) {
          await resolveAlertsByBooking(alert.phone, alert.date, alert.start_time);
          continue;
        }
        actionable.push(alert);
      }

      if (actionable.length === 0) {
        log('✅ [미해결 알림] 없음');
        return;
      }

      log(`⚠️ [미해결 알림] ${actionable.length}건 감지`);
      const summary = buildUnresolvedAlertsSummary(actionable);
      await Promise.resolve(publishReservationAlert({
        from_bot: 'andy',
        event_type: 'report',
        alert_level: 2,
        message: summary,
      }));
      log(`📱 미해결 알림 ${actionable.length}건 제이 큐 발송 완료`);
    } catch (error: any) {
      log(`⚠️ 미해결 알림 보고 실패: ${error?.message || String(error)}`);
    }
  }

  async function sendAlert(options: Record<string, any>): Promise<void> {
    try {
      const type = options.type || 'info';
      const title = options.title;
      const message = buildMonitorAlertMessage(options);

      log(message);

      const logFile = path.join(workspace, 'monitor-alert.log');
      const timestamp = toKst(new Date());
      fs.appendFileSync(logFile, `[${timestamp}] [${String(type).toUpperCase()}]\n${message}\n\n`);

      if (!['new', 'completed', 'cancelled', 'error'].includes(String(type)) || process.env.TELEGRAM_ENABLED === '0') {
        return;
      }

      try {
        const entryTimestamp = new Date().toISOString();
        const alertId = await addAlert({
          timestamp: entryTimestamp,
          type,
          title,
          message,
          phone: options.phone || null,
          date: options.date || null,
          startTime: options.start || null,
          resolved: type !== 'error' ? 1 : 0,
          resolvedAt: type !== 'error' ? entryTimestamp : null,
        });
        log(`💾 [알람 저장] ${String(type).toUpperCase()} - ${title}`);

        await Promise.resolve(publishReservationAlert({
          from_bot: 'andy',
          event_type: 'alert',
          alert_level: getAlertLevelByType(String(type)),
          message,
        }));
        await updateAlertSent(alertId, new Date().toISOString());
        await cleanupOldAlerts();
        await cleanupExpiredSeen();
      } catch (error: any) {
        log(`⚠️ 알람 전송 실패: ${error?.message || String(error)}`);
      }
    } catch (error: any) {
      log(`⚠️ 알람 전송 실패: ${error?.message || String(error)}`);
    }
  }

  async function sendNotification(message: string): Promise<void> {
    try {
      log(`📢 알림: ${message}`);
      const logFile = path.join(workspace, 'monitor-log.txt');
      const timestamp = toKst(new Date());
      fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`);
    } catch (error: any) {
      log(`⚠️ 알림 전송 실패: ${error?.message || String(error)}`);
    }
  }

  return {
    cleanupOldAlerts,
    resolveAlertsByBooking,
    resolveSystemAlertByTitle,
    reportUnresolvedAlerts,
    sendAlert,
    sendNotification,
  };
}
