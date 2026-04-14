const { execSync } = require('child_process') as typeof import('node:child_process');

const pgPool = require('../../../../packages/core/lib/pg-pool') as {
  get: (schema: string, sql: string, params?: any[]) => Promise<any>;
  query: (schema: string, sql: string, params?: any[]) => Promise<any[]>;
};
const kst = require('../../../../packages/core/lib/kst') as { today: () => string };
const { selectBestAgent } = require('../../../../packages/core/lib/hiring-contract') as {
  selectBestAgent: (role: string, team: string, options: Record<string, any>) => Promise<any>;
};

type SchedulerEvents = {
  date: string;
  postsPublished: number;
  tradesExecuted: number;
  researchCompleted: boolean;
  researchMetrics: Record<string, any>;
  unhealthyServices: Array<{ service: string; exitCode: number }>;
  lowScoreTeams: Array<{ team: string; lowCount: number }>;
  workflowSlow: boolean;
  newExperiences: number;
  performanceUp: boolean;
  errorSpikes: Array<{ service: string; exitCode: number }>;
};

type Formation = {
  date: string;
  weekday: number;
  targetTeams: string[];
  analysts: string[];
  events: SchedulerEvents;
  formationReason: string;
};

type MemorySnippet = {
  metadata?: Record<string, any>;
  importance?: number;
};

export const ROTATION = ['ska', 'worker', 'claude', 'justin', 'video'];
export const CORE_ANALYSTS = ['pipe', 'canvas', 'curator'];
const SIGMA_RANDOM_EPSILON = 0.2;
const KNOWN_MEMORY_TEAMS = new Set(['blog', 'luna', 'darwin', 'claude', 'worker', 'video', 'ska', 'justin']);

function safeExec(command: string): string {
  try {
    return execSync(command, {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 5000,
    }).trim();
  } catch {
    return '';
  }
}

export async function collectYesterdayEvents(): Promise<SchedulerEvents> {
  const [blogRow, tradeRow, researchRow, lowScoreRows] = await Promise.all([
    pgPool.get(
      'blog',
      `
      SELECT COUNT(*)::int AS posts_published
      FROM blog.posts
      WHERE created_at >= NOW() - interval '1 day'
        AND status IN ('ready', 'published')
    `,
      [],
    ).catch(() => ({ posts_published: 0 })),
    pgPool.get(
      'investment',
      `
      SELECT COUNT(*)::int AS trades_executed
      FROM investment.trades
      WHERE executed_at >= NOW() - interval '1 day'
    `,
      [],
    ).catch(() => ({ trades_executed: 0 })),
    pgPool.get(
      'reservation',
      `
      SELECT metadata
      FROM reservation.rag_research
      WHERE metadata->>'type' = 'daily_metrics'
        AND created_at >= NOW() - interval '2 days'
      ORDER BY created_at DESC
      LIMIT 1
    `,
      [],
    ).catch(() => ({ metadata: {} })),
    pgPool.query(
      'agent',
      `
      SELECT team, COUNT(*)::int AS low_count
      FROM agent.registry
      WHERE score < 5
      GROUP BY team
      ORDER BY low_count DESC, team ASC
    `,
      [],
    ).catch(() => []),
  ]);

  const launchdRaw = safeExec('launchctl list | egrep "ai\\."');
  const unhealthyServices = launchdRaw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      const parts = line.split(/\s+/);
      if (parts.length < 3) return false;
      const pid = parts[0];
      const exitCode = Number(parts[1]);
      return pid === '-' && exitCode !== 0;
    })
    .map((line) => {
      const parts = line.split(/\s+/);
      return { service: parts[2], exitCode: Number(parts[1]) };
    });

  const lowScoreTeams = lowScoreRows
    .filter((row) => Number(row.low_count || 0) > 0)
    .map((row) => ({ team: row.team, lowCount: Number(row.low_count || 0) }));

  return {
    date: kst.today(),
    postsPublished: Number(blogRow?.posts_published || 0),
    tradesExecuted: Number(tradeRow?.trades_executed || 0),
    researchCompleted: Number(researchRow?.metadata?.total_collected || 0) > 0,
    researchMetrics: researchRow?.metadata || {},
    unhealthyServices,
    lowScoreTeams,
    workflowSlow: Number(researchRow?.metadata?.duration_sec || 0) > 300,
    newExperiences: Number(researchRow?.metadata?.stored || 0),
    performanceUp: Number(blogRow?.posts_published || 0) >= 2 || Number(tradeRow?.trades_executed || 0) >= 2,
    errorSpikes: unhealthyServices,
  };
}

function selectPerspectiveHint(events: SchedulerEvents, date: Date = new Date()): string {
  const weekday = date.getDay();
  if ((events.errorSpikes || []).length > 0) return '리스크 실패 문제 분석';
  if (events.performanceUp) return '성장 성공 기회 분석';
  if (weekday === 5 || weekday === 0) return '주간 장기 추세 분석';
  if (Math.random() < SIGMA_RANDOM_EPSILON) {
    return ['리스크 실패 문제 분석', '성장 성공 기회 분석', '주간 장기 추세 분석'][Math.floor(Math.random() * 3)];
  }
  const rotation = ['리스크 실패 문제 분석', '성장 성공 기회 분석', '주간 장기 추세 분석'];
  return rotation[weekday % rotation.length];
}

function deriveMemoryTeams(memories: MemorySnippet[] = []): string[] {
  const counts = new Map<string, number>();
  for (const memory of memories) {
    const metadata = memory?.metadata || {};
    const importance = Number(memory?.importance || 0);
    const candidates = Array.isArray(metadata?.targetTeams) ? metadata.targetTeams : [];
    for (const team of candidates) {
      const normalized = String(team || '').trim().toLowerCase();
      if (!KNOWN_MEMORY_TEAMS.has(normalized)) continue;
      counts.set(normalized, (counts.get(normalized) || 0) + (importance >= 0.7 ? 2 : 1));
    }
  }
  return [...counts.entries()]
    .filter(([, score]) => score >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 2)
    .map(([team]) => team);
}

function buildMemoryAwareTaskHint(baseHint: string, memoryBoostTeams: string[] = []): string {
  if (!memoryBoostTeams.length) return baseHint;
  return `${baseHint} / 최근 기억 집중팀: ${memoryBoostTeams.join(', ')}`;
}

export async function decideTodayFormation(
  { date = new Date(), recentMemories = [] }: { date?: Date; recentMemories?: MemorySnippet[] } = {},
): Promise<Formation> {
  const events = await collectYesterdayEvents();
  const targetTeams = new Set<string>();
  const weekday = date.getDay();

  if (events.postsPublished > 0) targetTeams.add('blog');
  if (events.tradesExecuted > 0) targetTeams.add('luna');
  if (events.researchCompleted) targetTeams.add('darwin');
  for (const item of events.lowScoreTeams || []) targetTeams.add(item.team);
  for (const item of events.unhealthyServices || []) {
    if (item.service.includes('.claude.')) targetTeams.add('claude');
    if (item.service.includes('.worker.')) targetTeams.add('worker');
    if (item.service.includes('.video')) targetTeams.add('video');
    if (item.service.includes('.ska.')) targetTeams.add('ska');
    if (item.service.includes('.blog.')) targetTeams.add('blog');
  }

  targetTeams.add(ROTATION[weekday % ROTATION.length]);
  const memoryBoostTeams = deriveMemoryTeams(recentMemories);
  for (const team of memoryBoostTeams) targetTeams.add(team);

  const analysts = [...CORE_ANALYSTS];
  const perspectiveHint = selectPerspectiveHint(events, date);
  const memoryAwareHint = buildMemoryAwareTaskHint(perspectiveHint, memoryBoostTeams);
  const perspectiveAnalyst = await selectBestAgent('analyst', 'sigma', {
    mode: 'balanced',
    taskHint: memoryAwareHint,
    excludeNames: analysts,
  });
  if (perspectiveAnalyst?.name) analysts.push(perspectiveAnalyst.name);
  else analysts.push('pivot');

  if (events.workflowSlow || (events.unhealthyServices || []).length > 0) {
    const optimizer = await selectBestAgent('workflow', 'sigma', {
      mode: 'balanced',
      taskHint: '워크플로우 병목 최적화',
      excludeNames: analysts,
    });
    if (optimizer?.name) analysts.push(optimizer.name);
  }

  if (events.newExperiences > 10) {
    const librarian = await selectBestAgent('rag', 'sigma', {
      mode: 'balanced',
      taskHint: 'rag standing triplet 지식',
      excludeNames: analysts,
    });
    if (librarian?.name) analysts.push(librarian.name);
  }

  if (targetTeams.has('luna')) {
    const forecaster = await selectBestAgent('predictor', 'sigma', {
      mode: 'balanced',
      taskHint: memoryBoostTeams.includes('luna')
        ? '성과 예측 forecast / 최근 기억상 luna 집중'
        : '성과 예측 forecast',
      excludeNames: analysts,
    });
    if (forecaster?.name) analysts.push(forecaster.name);
  }

  return {
    date: kst.today(),
    weekday,
    targetTeams: [...targetTeams],
    analysts: [...new Set(analysts)],
    events,
    formationReason: memoryBoostTeams.length > 0
      ? `${perspectiveHint} / 기억 기반 보강: ${memoryBoostTeams.join(', ')}`
      : perspectiveHint,
  };
}
