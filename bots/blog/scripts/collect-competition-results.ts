#!/usr/bin/env node
'use strict';

const pgPool = require('../../../packages/core/lib/pg-pool');
const competitionEngine = require('../../../packages/core/lib/competition-engine');
const { publishToWebhook } = require('../../../packages/core/lib/reporting-hub');
const { createAgentMemory } = require('../../../packages/core/lib/agent-memory');

const TEAM = 'blog';
const COMPETITION_TIMEOUT_HOURS = 24;
const DEFAULT_REPAIR_DAYS = 14;
const competitionMemory = createAgentMemory({ agentId: 'blog.competition', team: TEAM });

type DateLike = string | number | Date;

type CliOptions = {
  repairTimeouts: boolean;
  dryRun: boolean;
  json: boolean;
  days: number;
};

type CompetitionRow = {
  id: number;
  team?: string;
  topic?: string;
  group_a_agents?: unknown;
  group_b_agents?: unknown;
  group_a_contract_ids?: unknown;
  group_b_contract_ids?: unknown;
  created_at: DateLike;
  completed_at?: DateLike | null;
};

type BlogPostRow = {
  id: number;
  title?: string;
  category?: string;
  status?: string;
  char_count?: number | string | null;
  content?: string | null;
  metadata?: {
    writer_name?: string;
  } | Record<string, unknown> | null;
  created_at?: DateLike;
};

type ContractRow = {
  id: number;
  agent_id?: number | string | null;
};

type GroupResult = {
  agents: string[];
  char_count: number;
  section_count: number;
  code_blocks: number;
  published_count: number;
  ai_risk: number;
  match_mode: string;
  matched_writers: string[];
};

type CompetitionEngineResult = {
  winner: 'a' | 'b';
  scoreA: number;
  scoreB: number;
  qualityDiff: number;
};

type CompetitionOutcome =
  | { status: 'no_result'; contractIdsA: unknown[]; contractIdsB: unknown[] }
  | { status: 'dry_run_ready'; contractIdsA: unknown[]; contractIdsB: unknown[]; resultA: GroupResult; resultB: GroupResult; winner: 'a' | 'b' }
  | { status: 'completed'; result: CompetitionEngineResult; contractIdsA: unknown[]; contractIdsB: unknown[] };

type CollectOptions = Partial<CliOptions> & {
  allowShared?: boolean;
  ignoreNextCompetitionBoundary?: boolean;
};

function _parseArgs(argv: string[] = process.argv.slice(2)): CliOptions {
  const args = new Set(argv);
  const daysArg = argv.find((item) => item.startsWith('--days='));
  const parsedDays = daysArg ? Number.parseInt(daysArg.split('=')[1], 10) : NaN;

  return {
    repairTimeouts: args.has('--repair-timeouts'),
    dryRun: args.has('--dry-run'),
    json: args.has('--json'),
    days: Number.isInteger(parsedDays) && parsedDays > 0 ? parsedDays : DEFAULT_REPAIR_DAYS,
  };
}

function _normalizeArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function _hoursSince(dateLike: DateLike): number {
  const timestamp = new Date(dateLike).getTime();
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 0;
  return (Date.now() - timestamp) / (1000 * 60 * 60);
}

function _buildCompetitionMemoryQuery(comp: CompetitionRow, outcome: Extract<CompetitionOutcome, { status: 'completed' }>): string {
  return [
    'blog competition completed',
    String(comp?.topic || '').trim(),
    outcome?.result?.winner === 'a' ? 'winner-a' : 'winner-b',
  ].filter(Boolean).join(' ');
}

async function _fetchRunningCompetitions(): Promise<CompetitionRow[]> {
  return pgPool.query(
    'agent',
    `SELECT id, team, topic, group_a_agents, group_b_agents,
            group_a_contract_ids, group_b_contract_ids, created_at
     FROM agent.competitions
     WHERE status = 'running'
     ORDER BY created_at ASC`,
  ) as Promise<CompetitionRow[]>;
}

async function _fetchRepairableTimeoutCompetitions(days = DEFAULT_REPAIR_DAYS): Promise<CompetitionRow[]> {
  return pgPool.query(
    'agent',
    `SELECT id, team, topic, group_a_agents, group_b_agents,
            group_a_contract_ids, group_b_contract_ids, created_at, completed_at
     FROM agent.competitions
     WHERE team = $1
       AND status = 'timeout'
       AND winner IS NULL
       AND created_at >= NOW() - ($2::text || ' days')::interval
     ORDER BY created_at ASC`,
    [TEAM, String(days)],
  ) as Promise<CompetitionRow[]>;
}

async function _resolveWindowEnd(team: string, createdAt: DateLike): Promise<Date> {
  const nextComp = await pgPool.get(
    'agent',
    `SELECT created_at
     FROM agent.competitions
     WHERE team = $1
       AND created_at > $2
     ORDER BY created_at ASC
     LIMIT 1`,
    [team, createdAt],
  );

  const created = new Date(createdAt);
  const maxEnd = new Date(created.getTime() + COMPETITION_TIMEOUT_HOURS * 60 * 60 * 1000);
  const nextCreated = nextComp?.created_at ? new Date(nextComp.created_at) : null;
  return nextCreated && nextCreated < maxEnd ? nextCreated : maxEnd;
}

function _resolveAbsoluteWindowEnd(createdAt: DateLike): Date {
  const created = new Date(createdAt);
  return new Date(created.getTime() + COMPETITION_TIMEOUT_HOURS * 60 * 60 * 1000);
}

async function _fetchTopicPostsInWindow(topic: unknown, createdAt: DateLike, windowEnd: Date | null = null): Promise<BlogPostRow[]> {
  const topicText = String(topic || '').trim();
  if (!topicText) return [];

  return pgPool.query(
    'blog',
    `SELECT id, title, category, status, char_count, content, metadata, created_at
     FROM blog.posts
     WHERE created_at >= $1
       AND created_at < $2
       AND status IN ('published', 'ready')
       AND (
         title ILIKE $3
         OR COALESCE(category, '') = $4
       )`,
    [
      createdAt,
      windowEnd || new Date(Date.now() + COMPETITION_TIMEOUT_HOURS * 60 * 60 * 1000),
      `%${topicText}%`,
      topicText,
    ],
  ) as Promise<BlogPostRow[]>;
}

async function _fetchPriorTopicPosts(topic: unknown, createdAt: DateLike): Promise<BlogPostRow[]> {
  const topicText = String(topic || '').trim();
  if (!topicText) return [];

  const start = new Date(new Date(createdAt).getTime() - COMPETITION_TIMEOUT_HOURS * 60 * 60 * 1000);

  return pgPool.query(
    'blog',
    `SELECT id, title, category, status, created_at
     FROM blog.posts
     WHERE created_at >= $1
       AND created_at < $2
       AND status IN ('published', 'ready', 'archived')
       AND (
         title ILIKE $3
         OR COALESCE(category, '') = $4
       )
     ORDER BY created_at DESC`,
    [start, createdAt, `%${topicText}%`, topicText],
  ) as Promise<BlogPostRow[]>;
}

async function _hasPriorCompletedCompetition(topic: unknown, createdAt: DateLike): Promise<boolean> {
  const row = await pgPool.get(
    'agent',
    `SELECT id
     FROM agent.competitions
     WHERE team = $1
       AND topic = $2
       AND status = 'completed'
       AND created_at < $3
       AND created_at >= $3 - INTERVAL '24 hours'
     ORDER BY created_at DESC
     LIMIT 1`,
    [TEAM, String(topic || '').trim(), createdAt],
  );

  return Boolean(row?.id);
}

function _collectGroupResultFromRows(rows: BlogPostRow[] = [], agents: unknown = [], options: CollectOptions = {}): GroupResult {
  const normalizedAgents = _normalizeArray(agents)
    .map((name) => String(name || '').trim())
    .filter(Boolean);
  const allowShared = options.allowShared === true;

  if (normalizedAgents.length === 0 || !Array.isArray(rows) || rows.length === 0) {
    return {
      agents: normalizedAgents,
      char_count: 0,
      section_count: 0,
      code_blocks: 0,
      published_count: 0,
      ai_risk: 20,
      match_mode: 'empty',
      matched_writers: [],
    };
  }

  const matchedRows = rows.filter((row) => {
    const writerName = String(row?.metadata?.writer_name || '').trim();
    return writerName && normalizedAgents.includes(writerName);
  });
  const targetRows = matchedRows.length > 0 ? matchedRows : (allowShared ? rows : []);

  let charCount = 0;
  let sectionCount = 0;
  let codeBlocks = 0;
  const matchedWriters = new Set<string>();

  for (const row of targetRows) {
    const content = String(row.content || '');
    charCount += Number(row.char_count || content.length || 0);
    sectionCount += (content.match(/^#{1,6}\s+/gm) || []).length;
    codeBlocks += (content.match(/```/g) || []).length / 2;
    const writerName = String(row?.metadata?.writer_name || '').trim();
    if (writerName) matchedWriters.add(writerName);
  }

  return {
    agents: normalizedAgents,
    char_count: charCount,
    section_count: Math.round(sectionCount),
    code_blocks: Math.round(codeBlocks),
    published_count: targetRows.length,
    ai_risk: targetRows.length > 0 ? (matchedRows.length > 0 ? 15 : 20) : 25,
    match_mode: matchedRows.length > 0 ? 'writer' : (targetRows.length > 0 ? 'shared_topic' : 'none'),
    matched_writers: Array.from(matchedWriters),
  };
}

async function _finalizeContracts(contractIds: unknown[] = [], status = 'completed', scoreResult: number | null = null): Promise<void> {
  const ids = _normalizeArray(contractIds)
    .map((id) => Number.parseInt(String(id), 10))
    .filter((id) => Number.isInteger(id) && id > 0);

  if (ids.length === 0) return;

  const contracts = await pgPool.query(
    'agent',
    `SELECT id, agent_id
     FROM agent.contracts
     WHERE id = ANY($1::int[])`,
    [ids],
  ) as ContractRow[];
  if (contracts.length === 0) return;

  await pgPool.run(
    'agent',
    `UPDATE agent.contracts
     SET status = $1,
         score_result = COALESCE($2, score_result),
         completed_at = COALESCE(completed_at, NOW())
     WHERE id = ANY($3::int[])`,
    [status, scoreResult, ids],
  );

  const agentIds = contracts
    .map((row: ContractRow) => Number.parseInt(String(row.agent_id || ''), 10))
    .filter((id) => Number.isInteger(id) && id > 0);

  if (agentIds.length > 0) {
    await pgPool.run(
      'agent',
      `UPDATE agent.registry
       SET status = 'idle', updated_at = NOW()
       WHERE id = ANY($1::int[])`,
      [agentIds],
    );
  }
}

async function _markTimeout(competitionId: number, hoursSinceCreated: number): Promise<void> {
  const competition = await pgPool.get(
    'agent',
    `SELECT group_a_contract_ids, group_b_contract_ids
     FROM agent.competitions
     WHERE id = $1`,
    [competitionId],
  );
  await pgPool.run(
    'agent',
    `UPDATE agent.competitions
     SET status = 'timeout', completed_at = NOW()
     WHERE id = $1`,
    [competitionId],
  );
  await _finalizeContracts([
    ..._normalizeArray(competition?.group_a_contract_ids),
    ..._normalizeArray(competition?.group_b_contract_ids),
  ], 'failed', 0);
  console.log(`[competition-collector] #${competitionId} timeout (${Math.round(hoursSinceCreated)}h)`);
}

async function _markSuperseded(competitionId: number, reason: string, metadata: Record<string, unknown> = {}): Promise<void> {
  await pgPool.run(
    'agent',
    `UPDATE agent.competitions
     SET status = 'superseded',
         completed_at = COALESCE(completed_at, NOW()),
         evaluation_detail = COALESCE(evaluation_detail, '{}'::jsonb) || $2::jsonb
     WHERE id = $1`,
    [competitionId, JSON.stringify({ resolution: 'superseded', reason, ...metadata })],
  );

  console.log(`[competition-collector] #${competitionId} superseded (${reason})`);
}

async function _collectCompetitionOutcome(comp: CompetitionRow, options: CollectOptions = {}): Promise<CompetitionOutcome> {
  const contractIdsA = _normalizeArray(comp.group_a_contract_ids);
  const contractIdsB = _normalizeArray(comp.group_b_contract_ids);
  const windowEnd = options.ignoreNextCompetitionBoundary
    ? _resolveAbsoluteWindowEnd(comp.created_at)
    : await _resolveWindowEnd(comp.team || TEAM, comp.created_at);
  const topicRows = await _fetchTopicPostsInWindow(comp.topic, comp.created_at, windowEnd);
  let resultA = _collectGroupResultFromRows(topicRows, comp.group_a_agents);
  let resultB = _collectGroupResultFromRows(topicRows, comp.group_b_agents);

  if (topicRows.length > 0 && resultA.published_count === 0 && resultB.published_count === 0) {
    resultA = _collectGroupResultFromRows(topicRows, comp.group_a_agents, { allowShared: true });
    resultB = _collectGroupResultFromRows(topicRows, comp.group_b_agents, { allowShared: true });
    console.log(
      `[competition-collector] #${comp.id} shared-topic fallback 사용 (${String(comp.topic || '').slice(0, 60)})`,
    );
  }

  const hasResult = resultA.published_count > 0 || resultB.published_count > 0;
  if (!hasResult) {
    return { status: 'no_result', contractIdsA, contractIdsB };
  }

  if (options.dryRun) {
    const evaluated = competitionEngine.evaluateResults(resultA, resultB) as CompetitionEngineResult;
    return {
      status: 'dry_run_ready',
      contractIdsA,
      contractIdsB,
      resultA,
      resultB,
      winner: evaluated.scoreA >= evaluated.scoreB ? 'a' : 'b',
    };
  }

  const result = await competitionEngine.completeCompetition(comp.id, resultA, resultB) as CompetitionEngineResult;
  const winnerContractIds = result.winner === 'a' ? contractIdsA : contractIdsB;
  const loserContractIds = result.winner === 'a' ? contractIdsB : contractIdsA;

  await _finalizeContracts(winnerContractIds, 'completed', 8);
  await _finalizeContracts(loserContractIds, 'completed', 4);

  return {
    status: 'completed',
    result,
    contractIdsA,
    contractIdsB,
  };
}

async function _repairTimeoutCompetitions(options: CollectOptions = {}) {
  const targets = await _fetchRepairableTimeoutCompetitions(options.days);
  if (targets.length === 0) {
    return { scanned: 0, repaired: 0, superseded: 0, unresolved: 0, dryRunReady: 0 };
  }

  let repaired = 0;
  let superseded = 0;
  let unresolved = 0;
  let dryRunReady = 0;

  for (const comp of targets) {
    const outcome = await _collectCompetitionOutcome(comp, {
      ...options,
      ignoreNextCompetitionBoundary: true,
    });

    if (outcome.status === 'completed') {
      repaired += 1;
      console.log(`[competition-collector] #${comp.id} timeout 복구 완료`);
      continue;
    }

    if (outcome.status === 'dry_run_ready') {
      dryRunReady += 1;
      console.log(`[competition-collector] #${comp.id} timeout 복구 가능 (dry-run)`);
      continue;
    }

    const priorTopicPosts = await _fetchPriorTopicPosts(comp.topic, comp.created_at);
    const hasPriorCompletedCompetition = await _hasPriorCompletedCompetition(comp.topic, comp.created_at);
    const supersedeReason =
      priorTopicPosts.length > 0 ? 'prior_topic_post_exists' :
      hasPriorCompletedCompetition ? 'prior_completed_competition_exists' :
      null;

    if (supersedeReason) {
      if (options.dryRun) {
        superseded += 1;
        console.log(`[competition-collector] #${comp.id} supersede 가능 (dry-run: ${supersedeReason})`);
      } else {
        await _markSuperseded(comp.id, supersedeReason, {
          prior_post_count: priorTopicPosts.length,
          prior_completed_competition: hasPriorCompletedCompetition,
        });
        superseded += 1;
      }
      continue;
    }

    unresolved += 1;
  }

  return { scanned: targets.length, repaired, superseded, unresolved, dryRunReady };
}

async function main() {
  const options = _parseArgs();

  if (options.repairTimeouts) {
    const repairSummary = await _repairTimeoutCompetitions(options);

    if (options.json) {
      console.log(JSON.stringify({ mode: 'repair_timeouts', ...repairSummary }, null, 2));
    } else {
      console.log(
        `[competition-collector] timeout 복구 scanned=${repairSummary.scanned}, repaired=${repairSummary.repaired}, superseded=${repairSummary.superseded}, unresolved=${repairSummary.unresolved}, dryRunReady=${repairSummary.dryRunReady}`,
      );
    }

    return;
  }

  const runningComps = await _fetchRunningCompetitions();
  if (runningComps.length === 0) {
    if (options.json) {
      console.log(JSON.stringify({ mode: 'collect_running', completed: 0, timeout: 0, pending: 0, running: 0 }, null, 2));
    } else {
      console.log('[competition-collector] running competition 없음 — 스킵');
    }
    return;
  }

  console.log(`[competition-collector] running competition ${runningComps.length}건`);

  let completed = 0;
  let timedOut = 0;
  let pending = 0;

  for (const comp of runningComps) {
    const contractIdsA = _normalizeArray(comp.group_a_contract_ids);
    const contractIdsB = _normalizeArray(comp.group_b_contract_ids);

    if (contractIdsA.length === 0 || contractIdsB.length === 0) {
      const hours = _hoursSince(comp.created_at);
      if (hours >= COMPETITION_TIMEOUT_HOURS) {
        await _markTimeout(comp.id, hours);
        timedOut += 1;
      } else {
        pending += 1;
      }
      continue;
    }

    const outcome = await _collectCompetitionOutcome(comp, options);

    if (outcome.status === 'no_result') {
      const hours = _hoursSince(comp.created_at);
      if (hours >= COMPETITION_TIMEOUT_HOURS) {
        await _markTimeout(comp.id, hours);
        timedOut += 1;
      } else {
        pending += 1;
      }
      continue;
    }

    if (outcome.status === 'dry_run_ready') {
      pending += 1;
      console.log(`[competition-collector] #${comp.id} 완료 가능 (dry-run)`);
      continue;
    }

    completed += 1;
    console.log(`[competition-collector] #${comp.id} 완료 — winner=${outcome.result.winner} diff=${outcome.result.qualityDiff}`);

    const memoryQuery = _buildCompetitionMemoryQuery(comp, outcome);
    const episodicHint = await competitionMemory.recallCountHint(memoryQuery, {
      type: 'episodic',
      limit: 2,
      threshold: 0.33,
      title: '최근 유사 경쟁',
      separator: 'pipe',
      metadataKey: 'kind',
      labels: {
        completed: '완료',
      },
      order: ['completed'],
    }).catch(() => '');
    const semanticHint = await competitionMemory.recallHint(`${memoryQuery} consolidated competition pattern`, {
      type: 'semantic',
      limit: 2,
      threshold: 0.28,
      title: '최근 통합 패턴',
      separator: 'newline',
    }).catch(() => '');
    const message =
      `🏆 경쟁 #${comp.id} 완료\n` +
      `📋 ${comp.topic}\n` +
      `🥇 승자: ${outcome.result.winner === 'a' ? 'A그룹' : 'B그룹'}\n` +
      `📊 차이: ${outcome.result.qualityDiff}` +
      episodicHint +
      semanticHint;

    await publishToWebhook({
      event: {
        from_bot: 'competition-collector',
        team: TEAM,
        event_type: 'blog_competition_completed',
        alert_level: 2,
        message,
      },
    }).catch((error: Error) => {
      console.warn(`[competition-collector] 알림 실패 #${comp.id}: ${error.message}`);
    });
    await competitionMemory.remember(message, 'episodic', {
      importance: 0.68,
      expiresIn: 1000 * 60 * 60 * 24 * 30,
      metadata: {
        kind: 'completed',
        topic: String(comp.topic || '').trim(),
        winner: outcome.result.winner,
        qualityDiff: outcome.result.qualityDiff,
      },
    }).catch(() => {});
    await competitionMemory.consolidate({
      olderThanDays: 14,
      limit: 10,
    }).catch(() => {});
  }

  if (options.json) {
    console.log(JSON.stringify({ mode: 'collect_running', completed, timeout: timedOut, pending, running: runningComps.length }, null, 2));
  } else {
    console.log(`[competition-collector] 완료=${completed}, timeout=${timedOut}, pending=${pending}`);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
