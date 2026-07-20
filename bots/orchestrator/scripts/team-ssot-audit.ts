#!/usr/bin/env tsx

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

type CatalogTeam = {
  id?: string;
  status?: string;
  name?: string;
};

type RegistryAgent = {
  name?: string;
  team?: string;
  status?: string;
};

type SeedAgent = {
  name?: string;
  team?: string;
};

type ContractDrift = {
  name?: string;
  team?: string;
  status?: string;
  active_contracts?: number | string;
  first_started_at?: string | Date | null;
  last_started_at?: string | Date | null;
};

type DeploymentEntry = {
  status?: string;
  inventoryKind?: string;
};

type AuditIssue = {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  details?: unknown;
  nextAction?: string;
};

type BuildOptions = {
  generatedAt?: string;
  catalogTeams?: CatalogTeam[];
  retiredTeams?: CatalogTeam[];
  dbAgents?: RegistryAgent[];
  seedAgents?: SeedAgent[];
  deploymentRegistry?: Record<string, DeploymentEntry>;
  readmeText?: string;
  activeContractDrift?: ContractDrift[];
  queryErrors?: string[];
};

const require = createRequire(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const README_PATH = path.join(REPO_ROOT, 'README.md');
const DEPLOYMENT_REGISTRY_PATH = path.join(REPO_ROOT, 'bots', 'registry.json');
const DB_TEAM_ALIASES = Object.freeze({
  research: 'darwin',
  data: 'sigma',
  orchestrator: 'jay',
  investment: 'luna',
  reservation: 'ska',
});
const DEPLOYMENT_TEAM_OWNERS = Object.freeze({
  orchestrator: 'jay',
});

function normalizeText(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function numeric(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function parseReadmeClaims(readmeText = '') {
  const claims: Array<{ source: string; agents: number | null; teams: number | null }> = [];
  const patterns = [
    {
      source: 'headline',
      regex: /(\d+)\s+autonomous agents across\s+(\d+)\s+specialized teams/gi,
      map: (match: RegExpExecArray) => ({ agents: Number(match[1]), teams: Number(match[2]) }),
    },
    {
      source: 'summary_banner',
      regex: /(\d+)\s+Teams\s*[•·]\s*(\d+)\s+Agents/gi,
      map: (match: RegExpExecArray) => ({ agents: Number(match[2]), teams: Number(match[1]) }),
    },
    {
      source: 'teams_heading',
      regex: /Teams\s*&\s*Agents\s*\((\d+)\s+total\)/gi,
      map: (match: RegExpExecArray) => ({ agents: Number(match[1]), teams: null }),
    },
    {
      source: 'system_stats',
      regex: /Agents:\s*(\d+)\s*\(across\s*(\d+)\s*teams\)/gi,
      map: (match: RegExpExecArray) => ({ agents: Number(match[1]), teams: Number(match[2]) }),
    },
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(readmeText)) !== null) {
      claims.push({ source: pattern.source, ...pattern.map(match) });
    }
  }
  return claims;
}

function addIssue(issues: AuditIssue[], issue: AuditIssue) {
  issues.push(issue);
}

export function buildTeamSsotAuditReport(options: BuildOptions = {}) {
  const catalogTeams = options.catalogTeams || [];
  const retiredTeams = options.retiredTeams || [];
  const retiredTeamIds = uniqueSorted(retiredTeams.map((team) => normalizeText(team.id)));
  const dbAgents = (options.dbAgents || []).filter((agent) => normalizeText(agent.status) !== 'archived');
  const seedAgents = options.seedAgents || [];
  const activeCatalogTeams = uniqueSorted(catalogTeams
    .filter((team) => normalizeText(team.status) === 'active')
    .map((team) => normalizeText(team.id)));
  const plannedCatalogTeams = uniqueSorted(catalogTeams
    .filter((team) => normalizeText(team.status) === 'planned')
    .map((team) => normalizeText(team.id)));
  const dbTeams = uniqueSorted(dbAgents.map((agent) => normalizeText(agent.team)));
  const dbNames = new Set(dbAgents.map((agent) => normalizeText(agent.name)));
  const missingDbTeams = activeCatalogTeams.filter((team) => !dbTeams.includes(team));
  const unexpectedDbTeams = dbTeams.filter((team) => !activeCatalogTeams.includes(team));
  const aliasRows = dbAgents.filter((agent) => Object.prototype.hasOwnProperty.call(
    DB_TEAM_ALIASES,
    normalizeText(agent.team),
  ));
  const retiredRuntimeRows = dbAgents.filter((agent) => retiredTeamIds.includes(normalizeText(agent.team)));
  const missingSeedAgents = uniqueSorted(seedAgents
    .map((agent) => normalizeText(agent.name))
    .filter((name) => name && !dbNames.has(name)));
  const claims = parseReadmeClaims(options.readmeText || '');
  const mismatchedClaims = claims.filter((claim) => (
    claim.agents !== null && claim.agents !== dbAgents.length
  ) || (
    claim.teams !== null && claim.teams !== activeCatalogTeams.length
  ));
  const issues: AuditIssue[] = [];

  for (const queryError of options.queryErrors || []) {
    addIssue(issues, {
      code: 'readonly_query_failed',
      severity: 'error',
      message: '레지스트리 읽기 전용 조회에 실패했습니다.',
      details: queryError,
      nextAction: 'DB 연결과 queryReadonly 경로를 복구한 뒤 재감사',
    });
  }
  if (missingDbTeams.length > 0 || unexpectedDbTeams.length > 0) {
    addIssue(issues, {
      code: 'db_active_team_mismatch',
      severity: 'error',
      message: 'agent.registry 운영 팀과 orchestrator active 팀이 일치하지 않습니다.',
      details: { missingDbTeams, unexpectedDbTeams },
      nextAction: '조직 lifecycle과 DB 소속 중 잘못된 축을 확인하고 별도 승인 후 정합화',
    });
  }
  if (aliasRows.length > 0) {
    addIssue(issues, {
      code: 'db_alias_team_rows',
      severity: 'error',
      message: 'agent.registry에 namespace alias가 canonical team 대신 저장돼 있습니다.',
      details: aliasRows.map((row) => ({
        name: row.name,
        team: row.team,
        canonicalTeam: DB_TEAM_ALIASES[normalizeText(row.team) as keyof typeof DB_TEAM_ALIASES],
      })),
      nextAction: 'alias 방향을 인증 namespace와 혼합하지 말고 agent registry 소속만 canonical team으로 교정',
    });
  }
  if (retiredRuntimeRows.length > 0) {
    addIssue(issues, {
      code: 'retired_team_runtime_rows',
      severity: 'error',
      message: '은퇴 팀 에이전트가 운영 registry에 활성 상태로 남아 있습니다.',
      details: retiredRuntimeRows.map((row) => ({ name: row.name, team: row.team, status: row.status })),
      nextAction: '해당 팀의 registry 행을 삭제하지 말고 archived 상태로 전환',
    });
  }
  if (missingSeedAgents.length > 0) {
    addIssue(issues, {
      code: 'seed_agent_missing',
      severity: 'error',
      message: '현재 bootstrap seed가 소유한 에이전트가 운영 registry에 없습니다.',
      details: missingSeedAgents,
      nextAction: '누락 원인을 확인한 뒤 seed apply 여부를 마스터가 결정',
    });
  }
  if (mismatchedClaims.length > 0 || claims.length === 0) {
    addIssue(issues, {
      code: 'readme_stats_drift',
      severity: 'warning',
      message: 'README 통계가 운영 registry와 active team catalog에서 파생되지 않았거나 오래됐습니다.',
      details: {
        expected: { agents: dbAgents.length, teams: activeCatalogTeams.length },
        claims,
        mismatchedClaims,
      },
      nextAction: 'README를 파생 문서로 취급하고 현재 운영 수치로 갱신',
    });
  }
  const activeContractDrift = options.activeContractDrift || [];
  if (activeContractDrift.length > 0) {
    addIssue(issues, {
      code: 'idle_agent_active_contract',
      severity: 'warning',
      message: 'idle 에이전트에 미종료 active 계약이 남아 있습니다.',
      details: activeContractDrift,
      nextAction: 'completeContract의 다중 active 계약 보호를 유지하고 기존 행 정리는 별도 DB 승인으로 수행',
    });
  }

  const inventory = Object.fromEntries(Object.entries(DEPLOYMENT_TEAM_OWNERS).map(([key, canonicalTeam]) => {
    const entry = options.deploymentRegistry?.[key] || {};
    return [key, {
      status: entry.status || null,
      inventoryKind: entry.inventoryKind || null,
      canonicalTeam,
      lifecycleSource: 'team-orchestrator.TEAMS + RETIRED_TEAMS',
      interpretation: 'deployment_inventory_only',
    }];
  }));
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length;

  return {
    ok: errorCount === 0,
    status: issues.length > 0 ? 'degraded' : 'healthy',
    generatedAt: options.generatedAt || new Date().toISOString(),
    ssot: {
      agentCountOwnershipRuntime: 'agent.registry',
      teamLifecycle: 'team-orchestrator.TEAMS + RETIRED_TEAMS',
      routingReadiness: 'llm-model-selector',
      deploymentInventory: 'bots/registry.json',
      documentation: 'README.md (derived)',
    },
    summary: {
      agents: dbAgents.length,
      activeTeams: activeCatalogTeams.length,
      plannedTeams: plannedCatalogTeams.length,
      retiredTeams: retiredTeamIds.length,
      seededAgents: seedAgents.length,
      errors: errorCount,
      warnings: warningCount,
    },
    catalog: {
      teams: catalogTeams,
      activeTeams: activeCatalogTeams,
      plannedTeams: plannedCatalogTeams,
      retiredTeams,
    },
    registry: {
      teams: dbTeams,
      missingDbTeams,
      unexpectedDbTeams,
      aliasRows: aliasRows.length,
      retiredRuntimeRows: retiredRuntimeRows.length,
      missingSeedAgents,
      activeContractDrift,
    },
    inventory,
    readme: {
      claims,
      mismatchedClaims,
    },
    issues,
    liveMutation: false,
    dbWrite: false,
  };
}

async function collectDbSnapshot() {
  const pgPool = require('../../../packages/core/lib/pg-pool.ts');
  const queryErrors: string[] = [];
  let dbAgents: RegistryAgent[] = [];
  let activeContractDrift: ContractDrift[] = [];
  try {
    dbAgents = await pgPool.queryReadonly('agent', `
      SELECT name, team, status
        FROM agent.registry
       WHERE LOWER(COALESCE(status, '')) <> 'archived'
       ORDER BY team, name
    `);
  } catch (error: any) {
    queryErrors.push(`agent.registry: ${error?.message || error}`);
  }
  try {
    activeContractDrift = await pgPool.queryReadonly('agent', `
      SELECT r.name,
             r.team,
             r.status,
             COUNT(c.id)::int AS active_contracts,
             MIN(c.started_at) AS first_started_at,
             MAX(c.started_at) AS last_started_at
        FROM agent.registry r
        JOIN agent.contracts c ON c.agent_id = r.id
       WHERE LOWER(COALESCE(r.status, '')) = 'idle'
         AND LOWER(COALESCE(c.status, '')) = 'active'
       GROUP BY r.id, r.name, r.team, r.status
       ORDER BY r.team, r.name
    `);
  } catch (error: any) {
    queryErrors.push(`agent.contracts: ${error?.message || error}`);
  }
  return { dbAgents, activeContractDrift, queryErrors };
}

async function main() {
  const pgPool = require('../../../packages/core/lib/pg-pool.ts');
  try {
    const { TEAMS, RETIRED_TEAMS } = require('../../../packages/core/lib/skills/team-orchestrator.ts');
    const { AGENTS } = require('./seed-agent-registry.ts');
    const deploymentRegistry = JSON.parse(fs.readFileSync(DEPLOYMENT_REGISTRY_PATH, 'utf8'))?.bots || {};
    const readmeText = fs.readFileSync(README_PATH, 'utf8');
    const dbSnapshot = await collectDbSnapshot();
    const report = buildTeamSsotAuditReport({
      catalogTeams: TEAMS,
      retiredTeams: RETIRED_TEAMS,
      dbAgents: dbSnapshot.dbAgents,
      seedAgents: AGENTS,
      deploymentRegistry,
      readmeText,
      activeContractDrift: dbSnapshot.activeContractDrift,
      queryErrors: dbSnapshot.queryErrors,
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } finally {
    await pgPool.closeAll();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`team-ssot-audit failed: ${error?.message || error}`);
    process.exit(1);
  });
}

export const _testOnly = {
  parseReadmeClaims,
  DB_TEAM_ALIASES,
  DEPLOYMENT_TEAM_OWNERS,
};
