// @ts-nocheck
'use strict';

/**
 * ska-auto-dev-builder.ts
 *
 * 스카팀 자기 복구 Layer 5: Auto-Dev Document 자동 생성
 *
 * Roundtable 합의 결과를 바탕으로:
 *   docs/auto_dev/CODEX_SKA_EXCEPTION_<error_type>_<hash>.md 생성
 *
 * Claude auto-dev-watch (ai.claude.auto-dev-watch)가 이 파일을 받아
 * → 구현계획 수립 → 구현 → 검증 → 적용
 *
 * 보안:
 *   - Bearer / JWT / API 키 자동 마스킹
 *   - 고객 전화번호 자동 마스킹 (010-XXXX-XXXX)
 *
 * 참조: bots/hub/lib/alarm/auto-dev-incident.ts 패턴
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');

const DEFAULT_AUTO_DEV_DIR = path.join(env.PROJECT_ROOT, 'docs', 'auto_dev');

function redactText(value: unknown): string {
  return String(value == null ? '' : value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password)\s*[:=]\s*['"]?[^,'"\s}]+/gi, '$1=[REDACTED]')
    .replace(/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9._-]{16,}/g, '[REDACTED_TOKEN]')
    .replace(/[A-Za-z0-9+/=]{48,}/g, '[REDACTED_BLOB]')
    .replace(/010[-\s]?\d{3,4}[-\s]?\d{4}/g, '010-****-****');
}

function normalizeText(value: unknown, fallback = ''): string {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function slugify(value: string): string {
  return normalizeText(value, 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9가-힣._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'unknown';
}

const CONDITION_TYPE_LABELS: Record<string, string> = {
  repeat_failure:  '반복 장애',
  selector_churn:  'DOM 셀렉터 잦은 변경',
  auth_storm:      '인증 반복 만료',
};

const ERROR_TYPE_LABELS: Record<string, string> = {
  selector_broken: 'CSS/XPath 셀렉터 깨짐',
  timeout:         '응답 타임아웃',
  auth_expired:    '세션/인증 만료',
  unknown:         '미분류 오류',
  network_error:   '네트워크 오류',
};

function buildTestScope(errorType: string): string[] {
  const base = ['npm --prefix bots/reservation run -s test:unit 2>/dev/null || true'];
  if (/selector/.test(errorType)) {
    base.push('npm --prefix bots/reservation run -s test:selector-smoke 2>/dev/null || true');
  }
  if (/auth/.test(errorType)) {
    base.push('npm --prefix bots/reservation run -s test:auth-smoke 2>/dev/null || true');
  }
  return base;
}

function buildWriteScope(condition: { agent: string; error_type: string }): string[] {
  const scopes = ['bots/reservation/lib', 'bots/ska/lib'];
  if (condition.agent === 'andy' || condition.agent === 'jimmy') {
    scopes.push('bots/reservation/auto/monitors');
  }
  if (/selector/.test(condition.error_type)) {
    scopes.push('bots/reservation/migrations');
  }
  return scopes;
}

/**
 * CODEX_SKA_EXCEPTION_*.md 문서 내용 빌드
 */
function buildSkaExceptionDocument(opts: {
  condition: {
    type: string;
    agent: string;
    error_type: string;
    count: number;
    failure_case_id?: number;
    metadata?: Record<string, unknown>;
  };
  consensus: {
    roundtable_id: string;
    root_cause: string;
    proposed_fix: string;
    estimated_complexity: string;
    risk_level: string;
    success_criteria: string;
  };
  reflexion?: {
    hindsight?: string;
    avoid_pattern?: { reason?: string; avoid_action?: string };
  } | null;
}): string {
  const { condition, consensus, reflexion } = opts;
  const createdAt = new Date().toISOString();
  const conditionLabel = CONDITION_TYPE_LABELS[condition.type] || condition.type;
  const errorLabel = ERROR_TYPE_LABELS[condition.error_type] || condition.error_type;
  const writeScope = buildWriteScope(condition);
  const testScope = buildTestScope(condition.error_type);

  const lines: string[] = [
    '---',
    'target_team: claude',
    'owner_agent: ska-auto-dev-builder',
    `source_team: ska`,
    `source_bot: ${condition.agent}`,
    `incident_key: ska-exception-${slugify(condition.error_type)}-${slugify(condition.agent)}`,
    `alarm_event_type: ska_exception_${condition.error_type}`,
    `risk_tier: ${consensus.risk_level === 'high' ? 'high' : 'medium'}`,
    'task_type: exception_case_implementation',
    'write_scope:',
    ...writeScope.map(s => `  - ${s}`),
    'test_scope:',
    ...testScope.map(s => `  - ${s}`),
    'autonomy_level: autonomous_l5',
    'requires_live_execution: false',
    'ska_never_block_operations: true',
    '---',
    '',
    `# SKA Exception Case: ${conditionLabel} — ${errorLabel}`,
    '',
    '## Council',
    '- Jay: 운영 영향과 우선순위를 검토한다.',
    '- Claude lead: 구현 계획을 수립하고 예외 케이스를 구현한다.',
    '- Ska Commander: 재현 조건과 회귀 테스트 기준을 제시한다.',
    '',
    '## Incident',
    `- created_at: ${createdAt}`,
    `- roundtable_id: ${consensus.roundtable_id}`,
    `- condition_type: ${condition.type} (${conditionLabel})`,
    `- agent: ${condition.agent}`,
    `- error_type: ${condition.error_type} (${errorLabel})`,
    `- occurrence_count: ${condition.count}회`,
    condition.failure_case_id ? `- failure_case_id: ${condition.failure_case_id}` : null,
    '',
    '## Roundtable Consensus',
    `- root_cause: ${redactText(consensus.root_cause)}`,
    `- proposed_fix: ${redactText(consensus.proposed_fix)}`,
    `- estimated_complexity: ${consensus.estimated_complexity}`,
    `- risk_level: ${consensus.risk_level}`,
    `- success_criteria: ${redactText(consensus.success_criteria)}`,
    '',
  ].filter(l => l !== null) as string[];

  // Reflexion 섹션 (있을 경우)
  if (reflexion?.hindsight) {
    lines.push(
      '## Reflexion (Layer 2)',
      `- hindsight: ${redactText(reflexion.hindsight)}`,
      reflexion.avoid_pattern?.reason ? `- avoid_reason: ${redactText(reflexion.avoid_pattern.reason)}` : null,
      reflexion.avoid_pattern?.avoid_action ? `- avoid_action: ${redactText(reflexion.avoid_pattern.avoid_action)}` : null,
      '',
    );
  }

  lines.push(
    '## Required Flow',
    '1. 재현 가능한 최소 원인을 찾는다.',
    '2. 동일/유사 오류가 반복되는지 ska.failure_cases 패턴을 확인한다.',
    '3. 예외 케이스 처리 코드를 구현한다 (ska.selector_history 활용 가능).',
    '4. 기존 동작에 영향 없는지 확인한다 (SKA_NEVER_BLOCK_OPERATIONS=true).',
    '5. smoke 테스트를 추가하거나 기존 테스트를 보강한다.',
    '6. 수정 완료 후 ska.failure_cases.auto_resolved = TRUE 업데이트.',
    '',
    '## Acceptance Criteria',
    `- ${redactText(consensus.success_criteria)}`,
    '- 동일 error_type + agent 조합의 재발률 50% 이상 감소.',
    '- 실거래 모니터링 (21 launchd) 중단 없음.',
    '- 기존 ska.failure_cases / selector_history 데이터 보존.',
    '',
    '## Safety Constraints',
    '- SKA_NEVER_BLOCK_OPERATIONS=true: 실거래 절대 중단 금지.',
    '- 셀렉터 변경 시 shadow mode 24h 검증 후 promoted.',
    '- DB 변경은 idempotent (CREATE IF NOT EXISTS, ON CONFLICT DO UPDATE).',
    '- 신규 kill switch 기본값은 false (안전).',
    '',
  );

  return lines.join('\n');
}

/**
 * 메인: CODEX_SKA_EXCEPTION_*.md 파일 생성
 */
export async function buildSkaIncidentDocument(opts: {
  condition: {
    type: string;
    agent: string;
    error_type: string;
    count: number;
    failure_case_id?: number;
    metadata?: Record<string, unknown>;
  };
  consensus: {
    roundtable_id: string;
    root_cause: string;
    proposed_fix: string;
    estimated_complexity: string;
    risk_level: string;
    success_criteria: string;
  };
  reflexion?: {
    hindsight?: string;
    avoid_pattern?: { reason?: string; avoid_action?: string };
  } | null;
}): Promise<{ ok: boolean; created: boolean; path: string }> {
  const dir = process.env.SKA_AUTO_DEV_DIR || DEFAULT_AUTO_DEV_DIR;

  const keyRaw = `ska-${opts.condition.agent}-${opts.condition.error_type}-${opts.consensus.roundtable_id}`;
  const keyHash = crypto.createHash('sha1').update(keyRaw).digest('hex').slice(0, 10);
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const fileName = `CODEX_SKA_EXCEPTION_${slugify(opts.condition.error_type).toUpperCase()}_${dateStr}_${keyHash}.md`;
  const filePath = path.join(dir, fileName);
  const relPath = path.relative(env.PROJECT_ROOT, filePath).replace(/\\/g, '/');

  await fs.promises.mkdir(dir, { recursive: true });

  if (fs.existsSync(filePath)) {
    return { ok: true, created: false, path: relPath };
  }

  const content = buildSkaExceptionDocument(opts);
  await fs.promises.writeFile(filePath, content, 'utf8');

  console.log(`[ska-auto-dev] 문서 생성: ${relPath}`);

  return { ok: true, created: true, path: relPath };
}

module.exports = { buildSkaIncidentDocument };
