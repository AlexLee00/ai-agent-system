// @ts-nocheck
'use strict';

const VALID_TEAMS = new Set(['claude', 'luna', 'blog', 'ska', 'darwin', 'sigma']);
const VALID_PRIORITIES = new Set(['low', 'normal', 'high']);
const VALID_HUB_SOURCES = new Set(['github', 'telegram', 'hub']);

const TEAM_KEYWORDS = [
  { team: 'luna', keywords: ['luna', 'trading', 'trade', 'crypto', 'binance', 'market', 'position', 'strategy', 'signal', '루나', '자동매매', '거래', '암호화폐', '전략', '시그널'] },
  { team: 'blog', keywords: ['blog', 'wordpress', 'post', 'seo', 'content', '블로그', '콘텐츠', '발행'] },
  { team: 'ska', keywords: ['ska', 'reservation', 'booking', 'korea', 'domestic', '예약', '국내장', '매출'] },
  { team: 'darwin', keywords: ['darwin', 'paper', 'research', 'arxiv', 'experiment', 'backtest', '논문', '연구', '실험'] },
  { team: 'sigma', keywords: ['sigma', 'dashboard', 'mape', 'liveview', 'elixir', 'phoenix', '시그마', '가시화', '대시보드'] },
  { team: 'claude', keywords: ['claude', 'dexter', 'doctor', 'archer', 'guardian', 'builder', 'reviewer', 'symphony', '클로드'] },
];

const CLAUDE_AGENT_RULES = [
  { agent: 'guardian', role: 'security_gate', keywords: ['security', 'vuln', 'owasp', 'secret', 'credential', '보안', '시크릿', '권한'] },
  { agent: 'builder', role: 'build_and_ci', keywords: ['build', 'compile', 'deploy', 'ci', 'test failure', '빌드', '배포', '컴파일'] },
  { agent: 'reviewer', role: 'code_review', keywords: ['review', 'pr', 'diff', 'pull request', '리뷰', '검토'] },
  { agent: 'doctor', role: 'repair', keywords: ['heal', 'repair', 'restart', 'down', 'crash', '복구', '재시작', '장애', '중단'] },
  { agent: 'dexter', role: 'monitoring', keywords: ['monitor', 'health', 'watch', 'status', '헬스', '상태', '모니터'] },
  { agent: 'archer', role: 'technical_intelligence', keywords: ['research', 'arxiv', 'analysis', 'trend', '분석', '리서치'] },
  { agent: 'learning', role: 'loopback_learning', keywords: ['learn', 'pattern', 'hermes', 'loopback', '학습', '패턴'] },
];

function nowIso() {
  return new Date().toISOString();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function toStringArray(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => typeof item === 'string' ? item : String(item?.name || item?.label || item || ''))
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}

function textOf(input) {
  if (input === undefined || input === null) return '';
  if (Array.isArray(input)) return input.map(textOf).filter(Boolean).join(' ');
  if (typeof input === 'object') return Object.values(input).map(textOf).join(' ');
  return String(input);
}

function normalizePriority(value) {
  const priority = String(value || 'normal').trim().toLowerCase();
  return VALID_PRIORITIES.has(priority) ? priority : 'normal';
}

function normalizeSource(value) {
  const source = String(value || 'hub').trim().toLowerCase();
  return VALID_HUB_SOURCES.has(source) ? source : 'hub';
}

function normalizeTicket(input = {}) {
  const p = asObject(input);
  const ticket = asObject(p.ticket || p.task || p.issue || p);
  const labels = [
    ...toStringArray(ticket.labels),
    ...toStringArray(p.labels),
  ];
  return {
    ...ticket,
    id: String(ticket.id || p.id || '').trim(),
    title: String(ticket.title || p.title || '').trim(),
    body: String(ticket.body || ticket.description || p.body || '').trim(),
    ticket_type: String(ticket.ticket_type || ticket.type || p.ticket_type || p.type || '').trim(),
    source: normalizeSource(ticket.source || p.source),
    priority: normalizePriority(ticket.priority || p.priority),
    labels,
    metadata: asObject(ticket.metadata || p.metadata),
  };
}

function keywordScore(haystack, keywords) {
  return keywords.reduce((score, keyword) => score + (haystack.includes(keyword.toLowerCase()) ? 1 : 0), 0);
}

function inferTargetTeam(ticketInput) {
  const ticket = normalizeTicket(ticketInput);
  const explicit = String(ticket.target_team || ticket.targetTeam || '').trim().toLowerCase();
  if (VALID_TEAMS.has(explicit)) {
    return { targetTeam: explicit, confidence: 0.95, reasons: ['explicit_target_team'] };
  }

  const labelTeam = toStringArray(ticket.labels)
    .map((label) => label.match(/^team[:/](claude|luna|blog|ska|darwin|sigma)$/i)?.[1]?.toLowerCase())
    .find(Boolean);
  if (VALID_TEAMS.has(labelTeam)) {
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

function inferAgent(ticketInput, targetTeam = '') {
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

function buildDispatchPlan(ticketInput) {
  const ticket = normalizeTicket(ticketInput);
  const team = inferTargetTeam(ticket);
  const agent = inferAgent(ticket, team.targetTeam);
  const reasons = [...(team.reasons || []), ...(agent.reasons || [])];
  const hubTaskPayload = {
    source: ticket.source,
    target_team: team.targetTeam,
    title: ticket.title || '(untitled symphony task)',
    body: ticket.body || null,
    priority: ticket.priority,
    ticket_type: ticket.ticket_type || null,
    source_ref: ticket.source_ref || ticket.sourceRef || ticket.id || null,
    ticket_external_id: ticket.ticket_external_id || ticket.ticketExternalId || null,
    assignee: agent.agent,
    metadata: {
      ...asObject(ticket.metadata),
      symphonyDispatch: {
        agent: agent.agent,
        role: agent.role,
        teamConfidence: team.confidence,
        agentConfidence: agent.confidence,
        reasons,
        plannedAt: nowIso(),
      },
    },
  };

  return {
    targetTeam: team.targetTeam,
    agent: agent.agent,
    role: agent.role,
    confidence: Math.min(Number(team.confidence || 0), Number(agent.confidence || 0)),
    reasons,
    hubTaskPayload,
  };
}

function validateDispatchPlan(plan = {}) {
  const blockers = [];
  const warnings = [];
  if (!VALID_TEAMS.has(plan.targetTeam)) blockers.push(`invalid_target_team:${plan.targetTeam || 'missing'}`);
  if (!plan.agent) blockers.push('missing_agent_assignment');
  if ((plan.confidence || 0) < 0.4) warnings.push('low_dispatch_confidence');
  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
  };
}

module.exports = {
  VALID_TEAMS,
  VALID_PRIORITIES,
  VALID_HUB_SOURCES,
  buildDispatchPlan,
  inferAgent,
  inferTargetTeam,
  normalizeTicket,
  validateDispatchPlan,
};
