const legacy = require('./db.legacy.js') as Record<string, any>;

export interface ReservationRecord {
  id?: string;
  compositeKey?: string | null;
  name?: string | null;
  name_enc?: string | null;
  phone?: string | null;
  phoneRaw?: string | null;
  phone_raw?: string | null;
  date?: string;
  start?: string;
  start_time?: string;
  end?: string | null;
  end_time?: string | null;
  room?: string | null;
  status?: string | null;
  pickkoStatus?: string | null;
  pickko_status?: string | null;
  pickkoOrderId?: string | null;
  pickko_order_id?: string | null;
  errorReason?: string | null;
  error_reason?: string | null;
  retries?: number;
  detectedAt?: string | null;
  pickkoStartTime?: string | null;
  pickkoCompleteTime?: string | null;
  updated_at?: string | null;
  [key: string]: unknown;
}

export interface AlertRecord {
  id?: number;
  type?: string | null;
  title?: string | null;
  message?: string | null;
  phone?: string | null;
  date?: string | null;
  start_time?: string | null;
  resolved?: number | boolean;
  timestamp?: string | null;
  [key: string]: unknown;
}

export interface DailySummaryRecord {
  date?: string;
  total_amount?: number | null;
  entries_count?: number | null;
  pickko_study_room?: number | null;
  general_revenue?: number | null;
  combined_revenue?: number | null;
  confirmed?: number | boolean | null;
  [key: string]: unknown;
}

export const query = legacy.query as (sql: string, params?: unknown[]) => Promise<any[]>;
export const run = legacy.run as (sql: string, params?: unknown[]) => Promise<any>;
export const get = legacy.get as (sql: string, params?: unknown[]) => Promise<any>;

export const initMigrationsTable = legacy.initMigrationsTable as () => void;
export const getAppliedMigrations = legacy.getAppliedMigrations as () => Promise<any[]>;
export const recordMigration = legacy.recordMigration as (version: string | number, name: string) => Promise<any>;
export const removeMigration = legacy.removeMigration as (version: string | number) => Promise<any>;
export const getSchemaVersion = legacy.getSchemaVersion as () => Promise<any>;

export const isSeenId = legacy.isSeenId as (id: string) => Promise<boolean>;
export const markSeen = legacy.markSeen as (id: string) => Promise<void>;
export const addReservation = legacy.addReservation as (id: string, data: ReservationRecord) => Promise<void>;
export const updateReservation = legacy.updateReservation as (id: string, updates: Partial<ReservationRecord>) => Promise<void>;
export const getReservation = legacy.getReservation as (id: string) => Promise<ReservationRecord | null>;
export const findReservationByBooking = legacy.findReservationByBooking as (
  phone: string,
  date: string,
  start: string,
) => Promise<ReservationRecord | null>;
export const findReservationByCompositeKey = legacy.findReservationByCompositeKey as (
  compositeKey: string,
) => Promise<ReservationRecord | null>;
export const findReservationBySlot = legacy.findReservationBySlot as (
  phone: string,
  date: string,
  start: string,
  room?: string | null,
) => Promise<ReservationRecord | null>;
export const getReservationsBySlot = legacy.getReservationsBySlot as (
  phone: string,
  date: string,
  start: string,
  room?: string | null,
) => Promise<ReservationRecord[]>;
export const hideDuplicateReservationsForSlot = legacy.hideDuplicateReservationsForSlot as (
  canonicalId: string,
  phone: string,
  date: string,
  start: string,
  room?: string | null,
) => Promise<number>;
export const getPendingReservations = legacy.getPendingReservations as () => Promise<ReservationRecord[]>;
export const getUnverifiedCompletedReservations = legacy.getUnverifiedCompletedReservations as () => Promise<ReservationRecord[]>;
export const getManualPendingReservations = legacy.getManualPendingReservations as (fromDate: string) => Promise<ReservationRecord[]>;
export const getVerifiedReservationsForPayScan = legacy.getVerifiedReservationsForPayScan as (
  fromDate: string,
  toDate: string,
) => Promise<ReservationRecord[]>;
export const getAllNaverKeys = legacy.getAllNaverKeys as () => Promise<string[]>;
export const getFuturePickkoRegistered = legacy.getFuturePickkoRegistered as (fromDate: string) => Promise<ReservationRecord[]>;
export const rollbackProcessing = legacy.rollbackProcessing as () => Promise<number>;
export const pruneOldReservations = legacy.pruneOldReservations as (cutoffDate: string) => Promise<number>;

export const isCancelledKey = legacy.isCancelledKey as (cancelKey: string) => Promise<boolean>;
export const addCancelledKey = legacy.addCancelledKey as (cancelKey: string) => Promise<void>;
export const pruneOldCancelledKeys = legacy.pruneOldCancelledKeys as (cutoffDate: string) => Promise<number>;

export const getKioskBlock = legacy.getKioskBlock as (...args: any[]) => Promise<any>;
export const upsertKioskBlock = legacy.upsertKioskBlock as (...args: any[]) => Promise<any>;
export const recordKioskBlockAttempt = legacy.recordKioskBlockAttempt as (...args: any[]) => Promise<any>;
export const getBlockedKioskBlocks = legacy.getBlockedKioskBlocks as () => Promise<any[]>;
export const getKioskBlocksForDate = legacy.getKioskBlocksForDate as (date: string) => Promise<any[]>;
export const getOpenManualBlockFollowups = legacy.getOpenManualBlockFollowups as (fromDate: string) => Promise<any[]>;
export const markKioskBlockManuallyConfirmed = legacy.markKioskBlockManuallyConfirmed as (...args: any[]) => Promise<any>;
export const resolveOpenKioskBlockFollowups = legacy.resolveOpenKioskBlockFollowups as (args?: Record<string, unknown>) => Promise<any>;
export const pruneOldKioskBlocks = legacy.pruneOldKioskBlocks as (beforeDate: string) => Promise<number>;

export const addAlert = legacy.addAlert as (data: AlertRecord) => Promise<number>;
export const updateAlertSent = legacy.updateAlertSent as (alertId: number, sentAt: string) => Promise<void>;
export const resolveAlert = legacy.resolveAlert as (phone: string, date: string, start: string) => Promise<number>;
export const resolveAlertsByTitle = legacy.resolveAlertsByTitle as (title: string) => Promise<number>;
export const getUnresolvedAlerts = legacy.getUnresolvedAlerts as () => Promise<AlertRecord[]>;
export const pruneOldAlerts = legacy.pruneOldAlerts as () => Promise<number>;

export const upsertDailySummary = legacy.upsertDailySummary as (date: string, data: DailySummaryRecord) => Promise<void>;
export const getDailySummary = legacy.getDailySummary as (date: string) => Promise<DailySummaryRecord | null>;
export const getDailySummariesInRange = legacy.getDailySummariesInRange as (
  startDate: string,
  endDate: string,
) => Promise<DailySummaryRecord[]>;
export const getUnconfirmedSummaryBefore = legacy.getUnconfirmedSummaryBefore as (cutoffDate: string) => Promise<DailySummaryRecord | null>;
export const getLatestUnconfirmedSummary = legacy.getLatestUnconfirmedSummary as () => Promise<DailySummaryRecord | null>;
export const confirmDailySummary = legacy.confirmDailySummary as (date: string) => Promise<any>;

export const upsertPickkoOrderRaw = legacy.upsertPickkoOrderRaw as (row: Record<string, unknown>) => Promise<void>;
export const upsertPickkoOrderRawBatch = legacy.upsertPickkoOrderRawBatch as (rows: Record<string, unknown>[]) => Promise<void>;
export const getPickkoOrderRawByDate = legacy.getPickkoOrderRawByDate as (
  sourceDate: string,
  sourceAxis?: string | null,
) => Promise<any[]>;

export const getRoomRevenueSummary = legacy.getRoomRevenueSummary as () => Promise<any[]>;
export const getTodayStats = legacy.getTodayStats as (date: string) => Promise<Record<string, unknown>>;

export const upsertFutureConfirmed = legacy.upsertFutureConfirmed as (
  bookingKey: string,
  phoneRaw: string,
  date: string,
  startTime: string,
  endTime: string,
  room: string,
  scanCycle: number,
) => Promise<void>;
export const getStaleConfirmed = legacy.getStaleConfirmed as (currentCycle: number, minDate: string) => Promise<any[]>;
export const deleteStaleConfirmed = legacy.deleteStaleConfirmed as (currentCycle: number, minDate: string) => Promise<number>;
export const pruneOldFutureConfirmed = legacy.pruneOldFutureConfirmed as (cutoffDate: string) => Promise<number>;
