import type { A2ATaskResult } from '../types.ts';

export const SYMPHONY_A2A_SKILLS = [
  {
    id: 'dispatch-ticket',
    name: 'Symphony 티켓 디스패치',
    description: 'ticket 입력을 팀/agent/Hub task payload로 라우팅한다.',
    tags: ['symphony', 'orchestration', 'dispatch', 'a2a'],
  },
  {
    id: 'poll-tasks',
    name: 'Symphony 태스크 폴링',
    description: 'Hub /hub/tasks 큐를 읽고 처리 후보를 반환한다.',
    tags: ['symphony', 'hub', 'polling', 'a2a'],
  },
  {
    id: 'assign-agent',
    name: 'Symphony Agent 할당',
    description: '태스크별 담당 agent와 격리 workspace 계획을 생성한다.',
    tags: ['symphony', 'agent', 'workspace', 'a2a'],
  },
  {
    id: 'report-status',
    name: 'Symphony 상태 보고',
    description: '상태 전환을 검증하고 Hub/GitHub 동기화 payload를 생성한다.',
    tags: ['symphony', 'status', 'github', 'a2a'],
  },
  {
    id: 'sync-github',
    name: 'Symphony GitHub 동기화',
    description: 'GitHub Issue/Webhook payload를 Symphony task로 정규화한다.',
    tags: ['symphony', 'github', 'webhook', 'a2a'],
  },
  {
    id: 'hermes-learn',
    name: 'Hermes 4-Stage 학습',
    description: '운영 evidence를 pattern/skill 후보로 변환하는 loopback 계획을 만든다.',
    tags: ['symphony', 'hermes', 'learning', 'a2a'],
  },
  {
    id: 'self-heal',
    name: 'Symphony Self Heal',
    description: 'Doctor L1/L2/L3 복구 계획과 실행 게이트를 반환한다.',
    tags: ['symphony', 'doctor', 'self-heal', 'a2a'],
  },
  {
    id: 'quality-gate',
    name: 'Symphony Quality Gate',
    description: 'Reviewer/Guardian/Builder/Test 결과를 promotion gate로 판정한다.',
    tags: ['symphony', 'quality', 'promotion', 'a2a'],
  },
];

export const SYMPHONY_FILESYSTEM_SKILLS = [
  'dexter-skill',
  'doctor-skill',
  'archer-skill',
  'guardian-skill',
  'builder-skill',
  'reviewer-skill',
  'orchestrator-skill',
  'learning-skill',
];

const TEAM_KEYWORDS = [
  { team: 'luna', keywords: ['luna', 'trading', 'trade', 'crypto', 'binance', 'market', 'position', '루나', '자동매매', '거래', '암호화폐'] },
  { team: 'blog', keywords: ['blog', 'wordpress', 'post', 'seo', 'content', '블로그', '콘텐츠'] },
  { team: 'ska', keywords: ['ska', 'reservation', 'booking', 'korea', 'domestic', '예약', '국내장'] },
  { team: 'darwin', keywords: ['darwin', 'paper', 'research', 'arxiv', 'experiment', '논문', '연구'] },
  { team: 'sigma', keywords: ['sigma', 'dashboard', 'mape', 'liveview', 'elixir', 'phoenix', '시그마', '가시화'] },
  { team: 'claude', keywords: ['claude', 'dexter', 'doctor', 'archer', 'guardian', 'builder', 'reviewer', 'symphony', '클로드'] },
];

const CLAUDE_AGENT_RULES = [
  { agent: 'guardian', role: 'security_gate', keywords: ['security', 'vuln', 'owasp', 'secret', 'credential', '보안', '시크릿'] },
  { agent: 'builder', role: 'build_and_ci', keywords: ['build', 'compile', 'deploy', 'ci', 'test failure', '빌드', '배포'] },
  { agent: 'reviewer', role: 'code_review', keywords: ['review', 'pr', 'diff', 'pull request', '리뷰', '검토'] },
  { agent: 'doctor', role: 'repair', keywords: ['heal', 'repair', 'restart', 'down', 'crash', '복구', '재시작', '장애'] },
  { agent: 'dexter', role: 'monitoring', keywords: ['monitor', 'health', 'watch', 'status', '헬스', '상태', '모니터'] },
  { agent: 'archer', role: 'technical_intelligence', keywords: ['research', 'arxiv', 'analysis', 'trend', '분석', '리서치'] },
  { agent: 'learning', role: 'loopback_learning', keywords: ['learn', 'pattern', 'hermes', 'loopback', '학습', '패턴'] },
];

export function nowIso(): string {
  return new Date().toISOString();
}

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function boolParam(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'y'].includes(String(value).toLowerCase());
}

export function dryRunEnabled(params: unknown): boolean {
  const p = asObject(params);
  return p.dryRun !== false;
}

export function textOf(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (Array.isArray(input)) return input.map(textOf).filter(Boolean).join(' ');
  if (typeof input === 'object') return Object.values(input as Record<string, unknown>).map(textOf).join(' ');
  return String(input);
}

export function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}

export function normalizeTicket(input: unknown): Record<string, unknown> {
  const p = asObject(input);
  const ticket = asObject(p.ticket || p.task || p.issue || p);
  const labels = [
    ...toStringArray(ticket.labels),
    ...toStringArray(p.labels),
  ];
  return {
    ...ticket,
    title: String(ticket.title || p.title || '').trim(),
    body: String(ticket.body || ticket.description || p.body || '').trim(),
    ticket_type: String(ticket.ticket_type || ticket.type || p.ticket_type || p.type || '').trim(),
    source: String(ticket.source || p.source || 'hub').trim(),
    priority: String(ticket.priority || p.priority || 'normal').trim(),
    labels,
    metadata: asObject(ticket.metadata || p.metadata),
  };
}

function keywordScore(haystack: string, keywords: string[]): number {
  return keywords.reduce((score, keyword) => score + (haystack.includes(keyword.toLowerCase()) ? 1 : 0), 0);
}

export function inferTargetTeam(ticketInput: unknown): Record<string, unknown> {
  const ticket = normalizeTicket(ticketInput);
  const explicit = String(ticket.target_team || ticket.targetTeam || '').trim();
  if (explicit) {
    return { targetTeam: explicit, confidence: 0.95, reasons: ['explicit_target_team'] };
  }

  const labelTeam = toStringArray(ticket.labels)
    .map((label) => label.match(/^team[:/](claude|luna|blog|ska|darwin|sigma)$/i)?.[1]?.toLowerCase())
    .find(Boolean);
  if (labelTeam) {
    return { targetTeam: labelTeam, confidence: 0.9, reasons: ['team_label'] };
  }

  const haystack = textOf([ticket.title, ticket.body, ticket.ticket_type, ticket.labels]).toLowerCase();
  const scored = TEAM_KEYWORDS
    .map((rule) => ({ team: rule.team, score: keywordScore(haystack, rule.keywords) }))
    .sort((a, b) => b.score - a.score);
  const winner = scored[0];
  if (winner && winner.score > 0) {
    return {
      targetTeam: winner.team,
      confidence: Math.min(0.85, 0.45 + winner.score * 0.15),
      reasons: [`keyword_match:${winner.team}:${winner.score}`],
    };
  }
  return { targetTeam: 'claude', confidence: 0.35, reasons: ['default_claude_orchestrator'] };
}

export function inferAgent(ticketInput: unknown, targetTeam = ''): Record<string, unknown> {
  const ticket = normalizeTicket(ticketInput);
  const explicit = String(ticket.assignee || ticket.owner_agent || ticket.ownerAgent || '').trim();
  if (explicit) return { agent: explicit, role: 'explicit', confidence: 0.95, reasons: ['explicit_agent'] };

  if (targetTeam && targetTeam !== 'claude') {
    return {
      agent: `${targetTeam}.lead`,
      role: 'team_lead_gateway',
      confidence: 0.75,
      reasons: ['non_claude_team_gateway'],
    };
  }

  const haystack = textOf([ticket.title, ticket.body, ticket.ticket_type, ticket.labels]).toLowerCase();
  const scored = CLAUDE_AGENT_RULES
    .map((rule) => ({ ...rule, score: keywordScore(haystack, rule.keywords) }))
    .sort((a, b) => b.score - a.score);
  const winner = scored[0];
  if (winner && winner.score > 0) {
    return {
      agent: winner.agent,
      role: winner.role,
      confidence: Math.min(0.9, 0.5 + winner.score * 0.15),
      reasons: [`agent_keyword_match:${winner.agent}:${winner.score}`],
    };
  }
  return { agent: 'orchestrator', role: 'default_dispatcher', confidence: 0.45, reasons: ['default_orchestrator'] };
}

export function buildDispatchPlan(ticketInput: unknown): Record<string, unknown> {
  const ticket = normalizeTicket(ticketInput);
  const team = inferTargetTeam(ticket);
  const agent = inferAgent(ticket, String(team.targetTeam));
  const hubTaskPayload = {
    source: String(ticket.source || 'hub'),
    target_team: team.targetTeam,
    title: ticket.title || '(untitled symphony task)',
    body: ticket.body || null,
    priority: ticket.priority || 'normal',
    ticket_type: ticket.ticket_type || null,
    source_ref: ticket.source_ref || ticket.sourceRef || null,
    ticket_external_id: ticket.ticket_external_id || ticket.ticketExternalId || null,
    assignee: agent.agent,
    metadata: {
      ...asObject(ticket.metadata),
      symphonyDispatch: {
        agent: agent.agent,
        role: agent.role,
        teamConfidence: team.confidence,
        agentConfidence: agent.confidence,
        reasons: [...(team.reasons as string[] || []), ...(agent.reasons as string[] || [])],
        plannedAt: nowIso(),
      },
    },
  };

  return {
    targetTeam: team.targetTeam,
    agent: agent.agent,
    role: agent.role,
    confidence: Math.min(Number(team.confidence || 0), Number(agent.confidence || 0)),
    reasons: [...(team.reasons as string[] || []), ...(agent.reasons as string[] || [])],
    hubTaskPayload,
  };
}

export async function hubJson(path: string, {
  method = 'GET',
  body = undefined,
  hubUrl = process.env.HUB_URL || 'http://localhost:7788',
  timeoutMs = 2000,
} = {}): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${hubUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, payload };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function completed(skill: string, output: Record<string, unknown>): A2ATaskResult {
  return {
    id: '',
    status: 'completed',
    output: {
      skill,
      ...output,
      completedAt: nowIso(),
    },
  };
}

export function buildSafety(dryRun: boolean, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dryRun,
    mutatesHub: dryRun ? false : Boolean(extra.mutatesHub),
    mutatesGit: false,
    mutatesLaunchd: false,
    mutatesSecrets: false,
    startsProtectedProcess: false,
    ...extra,
  };
}
