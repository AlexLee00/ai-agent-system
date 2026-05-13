// @ts-nocheck
const path = require('path');
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const pgPool = require(path.join(PROJECT_ROOT, 'packages/core/lib/pg-pool'));
const billingGuard = require(path.join(PROJECT_ROOT, 'packages/core/lib/billing-guard'));

const TEAM_QUOTAS: Record<string, number> = {
  luna: 30,
  darwin: 15,
  sigma: 10,
  claude: 10,
  blog: 5,
  ska: 5,
  justin: 3,
  hub: 5,
  data: 2,
};

const GLOBAL_LIMIT_USD = 80;
const EMERGENCY_CUTOFF_USD = 100;
const REFRESH_INTERVAL_MS = 60 * 1000;
const WARN_RATIO = 0.8;

interface TeamUsage {
  used: number;
  quota: number;
}

interface UsageState {
  global_used: number;
  global_limit: number;
  global_ratio: number;
  emergency: boolean;
  teams: Record<string, TeamUsage>;
}

interface CheckResult {
  ok: boolean;
  reason?: string;
  globalRatio: number;
  teamRatio: number;
}

export class BudgetGuardian {
  private static _instance: BudgetGuardian | null = null;

  private globalUsed: number = 0;
  private teamUsed: Record<string, number> = {};
  private warnedGlobal80: boolean = false;
  private warnedGlobal100: boolean = false;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  private constructor() {
    // Initialize team usage tracking
    for (const team of Object.keys(TEAM_QUOTAS)) {
      this.teamUsed[team] = 0;
    }

    // Auto-refresh every 60 seconds
    if (process.env.HUB_BUDGET_GUARDIAN_ENABLED !== 'false') {
      this.refreshTimer = setInterval(() => {
        this.refreshFromDb().catch(e =>
          console.warn('[budget-guardian] DB refresh 실패:', e.message)
        );
      }, REFRESH_INTERVAL_MS);
      this.refreshTimer.unref?.();

      // Initial load
      this.refreshFromDb().catch(e =>
        console.warn('[budget-guardian] 초기 DB 로드 실패:', e.message)
      );
    }
  }

  static getInstance(): BudgetGuardian {
    if (!BudgetGuardian._instance) {
      BudgetGuardian._instance = new BudgetGuardian();
    }
    return BudgetGuardian._instance;
  }

  checkAndReserve(team: string, estimatedCost: number): CheckResult {
    if (process.env.HUB_BUDGET_GUARDIAN_ENABLED === 'false') {
      return { ok: true, globalRatio: 0, teamRatio: 0 };
    }

    const normalizedTeam = normalizeTeam(team);
    const activeStop = billingGuard.getBlockReason(normalizedTeam);
    if (activeStop) {
      return {
        ok: false,
        reason: `BillingGuard 차단(${activeStop.scope || normalizedTeam}): ${activeStop.reason || 'active_stop_file'}`,
        globalRatio: this.globalUsed / GLOBAL_LIMIT_USD,
        teamRatio: 0,
      };
    }

    const globalRatio = this.globalUsed / GLOBAL_LIMIT_USD;
    const teamQuota = TEAM_QUOTAS[normalizedTeam] ?? 5;
    const teamUsedAmt = this.teamUsed[normalizedTeam] ?? 0;
    const teamRatio = teamUsedAmt / teamQuota;

    // Emergency cutoff
    if (this.globalUsed >= EMERGENCY_CUTOFF_USD) {
      return {
        ok: false,
        reason: `긴급 차단: 전체 비용 $${this.globalUsed.toFixed(2)} >= 한도 $${EMERGENCY_CUTOFF_USD}`,
        globalRatio,
        teamRatio,
      };
    }

    // Global limit
    if (this.globalUsed + estimatedCost > GLOBAL_LIMIT_USD) {
      return {
        ok: false,
        reason: `전체 일일 예산 초과: $${this.globalUsed.toFixed(2)}/$${GLOBAL_LIMIT_USD}`,
        globalRatio,
        teamRatio,
      };
    }

    // Team limit
    if (teamUsedAmt + estimatedCost > teamQuota) {
      return {
        ok: false,
        reason: `${normalizedTeam} 팀 예산 초과: $${teamUsedAmt.toFixed(2)}/$${teamQuota}`,
        globalRatio,
        teamRatio,
      };
    }

    return { ok: true, globalRatio, teamRatio };
  }

  trackCost(team: string, actualCost: number): void {
    team = normalizeTeam(team);
    this.globalUsed += actualCost;
    this.teamUsed[team] = (this.teamUsed[team] ?? 0) + actualCost;

    // Send alarm at 80% global
    const globalRatio = this.globalUsed / GLOBAL_LIMIT_USD;
    if (!this.warnedGlobal80 && globalRatio >= WARN_RATIO) {
      this.warnedGlobal80 = true;
      this.sendAlarm(`⚠️ LLM 전체 예산 80% 도달: $${this.globalUsed.toFixed(2)}/$${GLOBAL_LIMIT_USD}`);
    }

    // Send alarm at 100% (emergency)
    if (!this.warnedGlobal100 && this.globalUsed >= GLOBAL_LIMIT_USD) {
      this.warnedGlobal100 = true;
      this.sendAlarm(`🔴 LLM 전체 예산 100% 초과: $${this.globalUsed.toFixed(2)}/$${GLOBAL_LIMIT_USD} — 신규 요청 차단`);
    }
  }

  getCurrentUsage(team?: string): UsageState & { team?: TeamUsage } {
    const globalRatio = this.globalUsed / GLOBAL_LIMIT_USD;
    const teams: Record<string, TeamUsage> = {};
    for (const [t, quota] of Object.entries(TEAM_QUOTAS)) {
      teams[t] = { used: this.teamUsed[t] ?? 0, quota };
    }

    const base: UsageState = {
      global_used: this.globalUsed,
      global_limit: GLOBAL_LIMIT_USD,
      global_ratio: globalRatio,
      emergency: this.globalUsed >= EMERGENCY_CUTOFF_USD,
      teams,
    };

    if (team) {
      return { ...base, team: teams[normalizeTeam(team)] };
    }
    return base;
  }

  async refreshFromDb(): Promise<void> {
    try {
      const rows = await queryRequestLogCosts();
      let newGlobal = 0;
      const newTeamUsed: Record<string, number> = {};
      for (const row of rows) {
        const team = normalizeTeam(row.caller_team || row.team || 'hub');
        const cost = Number(row.total || row.cost || 0);
        newTeamUsed[team] = (newTeamUsed[team] || 0) + cost;
        newGlobal += cost;
      }

      this.globalUsed = newGlobal;
      for (const team of Object.keys(TEAM_QUOTAS)) {
        this.teamUsed[team] = newTeamUsed[team] ?? 0;
      }
    } catch (e: any) {
      console.warn('[budget-guardian] refreshFromDb 오류:', e.message);
    }
  }

  private sendAlarm(message: string): void {
    try {
      const hubClient = require(path.join(PROJECT_ROOT, 'packages/core/lib/hub-client'));
      hubClient.callHub('/hub/alarm', { message, channel: 'general' }).catch(() => {});
    } catch {
      console.warn('[budget-guardian] 알람 전송 실패:', message);
    }
  }
}

function normalizeTeam(team = 'hub'): string {
  const normalized = String(team || 'hub').trim().toLowerCase() || 'hub';
  if (normalized === 'luna') return 'luna';
  if (normalized === 'investment') return 'luna';
  if (normalized === 'jay' || normalized === 'orchestrator') return 'hub';
  return normalized;
}

async function queryRequestLogCosts(): Promise<Array<{ caller_team?: string; team?: string; total?: number | string; cost?: number | string }>> {
  try {
    return await pgPool.query('public', `
      SELECT COALESCE(NULLIF(caller_team, ''), 'hub') AS caller_team,
             COALESCE(SUM(cost_usd), 0) AS total
      FROM hub.llm_request_log
      WHERE created_at >= CURRENT_DATE
      GROUP BY 1
    `);
  } catch {
    return pgPool.query('public', `
      SELECT COALESCE(NULLIF(caller_team, ''), 'hub') AS caller_team,
             COALESCE(SUM(cost_usd), 0) AS total
      FROM public.llm_routing_log
      WHERE created_at >= CURRENT_DATE
      GROUP BY 1
    `);
  }
}
