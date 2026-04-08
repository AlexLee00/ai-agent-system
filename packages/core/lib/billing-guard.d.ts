type BillingGuardStopData = {
  activated_at?: string;
  reason?: string;
  cost_usd?: number;
  activated_by?: string;
  scope?: string;
  release?: string;
  expires_at?: string;
  stop_file?: string;
};

declare const billingGuard: {
  isBlocked(scope?: string): boolean;
  getBlockReason(scope?: string): BillingGuardStopData | null;
  activate(
    reason: string,
    costUsd: number,
    activatedBy?: string,
    scope?: string,
    options?: { ttlMs?: number }
  ): BillingGuardStopData;
  deactivate(scope?: string): boolean;
  listActiveGuards(scopePrefix?: string): BillingGuardStopData[];
  normalizeScope(scope?: string): string;
  scopeMatches(targetScope?: string, actualScope?: string): boolean;
  getStopFile(scope?: string): string;
  getDefaultAutoTtlMs(scope?: string): number;
  STOP_FILE: string;
};

export = billingGuard;
