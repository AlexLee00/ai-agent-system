'use strict';

/**
 * Symphony team-dispatcher.ts 단위 테스트
 *
 * 실행: node bots/claude/__tests__/symphony-team-dispatcher.test.ts
 */

const assert = require('assert');
const path = require('path');

const DISPATCHER_PATH = path.resolve(__dirname, '../lib/symphony/team-dispatcher.ts');

function loadDispatcher() {
  delete require.cache[DISPATCHER_PATH];
  return require(DISPATCHER_PATH);
}

// ─── normalizeTicket ─────────────────────────────────────────────────────────

async function test_normalizeTicket_flat_input() {
  const { normalizeTicket } = loadDispatcher();
  const t = normalizeTicket({ id: 'abc', title: '  Hello  ', source: 'github', priority: 'high' });
  assert.strictEqual(t.id, 'abc');
  assert.strictEqual(t.title, 'Hello');
  assert.strictEqual(t.source, 'github');
  assert.strictEqual(t.priority, 'high');
  console.log('✅ normalizeTicket: flat input normalized');
}

async function test_normalizeTicket_invalid_source_falls_back_to_hub() {
  const { normalizeTicket } = loadDispatcher();
  const t = normalizeTicket({ id: 'x', title: 'T', source: 'notion' });
  assert.strictEqual(t.source, 'hub', 'invalid source → hub fallback');
  console.log('✅ normalizeTicket: invalid source falls back to hub');
}

async function test_normalizeTicket_invalid_priority_falls_back_to_normal() {
  const { normalizeTicket } = loadDispatcher();
  const t = normalizeTicket({ id: 'y', title: 'T', source: 'hub', priority: 'critical' });
  assert.strictEqual(t.priority, 'normal', 'invalid priority → normal fallback');
  console.log('✅ normalizeTicket: invalid priority falls back to normal');
}

async function test_normalizeTicket_nested_ticket_field() {
  const { normalizeTicket } = loadDispatcher();
  const t = normalizeTicket({ ticket: { id: 'nested', title: 'Nested Title', source: 'hub', priority: 'low' } });
  assert.strictEqual(t.id, 'nested');
  assert.strictEqual(t.title, 'Nested Title');
  console.log('✅ normalizeTicket: nested ticket field unwrapped');
}

async function test_normalizeTicket_labels_merged_from_ticket_and_root() {
  const { normalizeTicket } = loadDispatcher();
  const t = normalizeTicket({
    id: 'l1',
    title: 'T',
    source: 'hub',
    labels: [{ name: 'team:claude' }],
    ticket: { labels: ['type:analysis'] },
  });
  assert.ok(t.labels.includes('type:analysis'), 'ticket.labels included');
  console.log('✅ normalizeTicket: labels merged from both ticket and root');
}

// ─── inferTargetTeam ─────────────────────────────────────────────────────────

async function test_inferTargetTeam_explicit_team_field() {
  const { inferTargetTeam } = loadDispatcher();
  const result = inferTargetTeam({ target_team: 'luna', title: 'foo' });
  assert.strictEqual(result.targetTeam, 'luna');
  assert.ok(result.confidence >= 0.9, 'explicit → high confidence');
  assert.ok(result.reasons.includes('explicit_target_team'));
  console.log('✅ inferTargetTeam: explicit target_team respected');
}

async function test_inferTargetTeam_team_label() {
  const { inferTargetTeam } = loadDispatcher();
  const result = inferTargetTeam({ title: 'some task', labels: [{ name: 'team:darwin' }] });
  assert.strictEqual(result.targetTeam, 'darwin');
  assert.ok(result.confidence >= 0.9);
  console.log('✅ inferTargetTeam: team label routing');
}

async function test_inferTargetTeam_keyword_blog() {
  const { inferTargetTeam } = loadDispatcher();
  const result = inferTargetTeam({ title: '블로그 포스트 발행 요청' });
  assert.strictEqual(result.targetTeam, 'blog');
  console.log('✅ inferTargetTeam: blog keyword match');
}

async function test_inferTargetTeam_keyword_luna_trading() {
  const { inferTargetTeam } = loadDispatcher();
  const result = inferTargetTeam({ title: 'crypto trading signal update' });
  assert.strictEqual(result.targetTeam, 'luna');
  console.log('✅ inferTargetTeam: luna/trading keyword match');
}

async function test_inferTargetTeam_keyword_ska_reservation() {
  const { inferTargetTeam } = loadDispatcher();
  const result = inferTargetTeam({ title: '예약 매출 리포트' });
  assert.strictEqual(result.targetTeam, 'ska');
  console.log('✅ inferTargetTeam: ska/reservation keyword match');
}

async function test_inferTargetTeam_keyword_darwin_research() {
  const { inferTargetTeam } = loadDispatcher();
  const result = inferTargetTeam({ title: 'arxiv paper analysis backtest' });
  assert.strictEqual(result.targetTeam, 'darwin');
  console.log('✅ inferTargetTeam: darwin/research keyword match');
}

async function test_inferTargetTeam_default_claude_for_unknown() {
  const { inferTargetTeam } = loadDispatcher();
  const result = inferTargetTeam({ title: '기타 작업 요청' });
  assert.strictEqual(result.targetTeam, 'claude', 'unknown → default claude');
  console.log('✅ inferTargetTeam: defaults to claude for unknown keywords');
}

async function test_inferTargetTeam_invalid_explicit_falls_to_keyword() {
  const { inferTargetTeam } = loadDispatcher();
  const result = inferTargetTeam({ target_team: 'invalid_team', title: 'crypto trading' });
  assert.strictEqual(result.targetTeam, 'luna', 'invalid explicit → keyword fallback');
  console.log('✅ inferTargetTeam: invalid explicit team falls to keyword routing');
}

// ─── inferAgent ──────────────────────────────────────────────────────────────

async function test_inferAgent_explicit_agent() {
  const { inferAgent } = loadDispatcher();
  const result = inferAgent({ assignee: 'guardian' }, 'claude');
  assert.strictEqual(result.agent, 'guardian');
  assert.ok(result.confidence >= 0.9);
  console.log('✅ inferAgent: explicit assignee respected');
}

async function test_inferAgent_non_claude_team_returns_team_lead() {
  const { inferAgent } = loadDispatcher();
  const result = inferAgent({ title: 'foo' }, 'luna');
  assert.ok(result.agent.startsWith('luna'), 'non-claude → team.lead gateway');
  assert.strictEqual(result.role, 'team_lead_gateway');
  console.log('✅ inferAgent: non-claude team → team.lead gateway');
}

async function test_inferAgent_security_keyword_to_guardian() {
  const { inferAgent } = loadDispatcher();
  const result = inferAgent({ title: '보안 취약점 점검 요청', body: 'security vulnerability' }, 'claude');
  assert.strictEqual(result.agent, 'guardian');
  console.log('✅ inferAgent: security keyword → guardian');
}

async function test_inferAgent_build_keyword_to_builder() {
  const { inferAgent } = loadDispatcher();
  const result = inferAgent({ title: '빌드 배포 실패 수정' }, 'claude');
  assert.strictEqual(result.agent, 'builder');
  console.log('✅ inferAgent: build keyword → builder');
}

async function test_inferAgent_monitor_keyword_to_dexter() {
  const { inferAgent } = loadDispatcher();
  const result = inferAgent({ title: '헬스 상태 모니터링' }, 'claude');
  assert.strictEqual(result.agent, 'dexter');
  console.log('✅ inferAgent: monitor/health keyword → dexter');
}

async function test_inferAgent_repair_keyword_to_doctor() {
  const { inferAgent } = loadDispatcher();
  const result = inferAgent({ title: '서비스 장애 복구 재시작' }, 'claude');
  assert.strictEqual(result.agent, 'doctor');
  console.log('✅ inferAgent: repair keyword → doctor');
}

// ─── buildDispatchPlan ───────────────────────────────────────────────────────

async function test_buildDispatchPlan_luna_ticket() {
  const { buildDispatchPlan } = loadDispatcher();
  const plan = buildDispatchPlan({ id: 't1', title: '루나 거래 전략 업데이트', source: 'hub', priority: 'high' });
  assert.strictEqual(plan.targetTeam, 'luna');
  assert.ok(plan.confidence > 0);
  assert.ok(Array.isArray(plan.reasons));
  assert.ok(plan.hubTaskPayload.title.length > 0);
  assert.strictEqual(plan.hubTaskPayload.target_team, 'luna');
  console.log('✅ buildDispatchPlan: luna ticket routed correctly');
}

async function test_buildDispatchPlan_blog_ticket() {
  const { buildDispatchPlan } = loadDispatcher();
  const plan = buildDispatchPlan({ id: 't2', title: '블로그 SEO 최적화', source: 'hub' });
  assert.strictEqual(plan.targetTeam, 'blog');
  assert.ok(plan.hubTaskPayload.assignee.length > 0, 'assignee set');
  console.log('✅ buildDispatchPlan: blog ticket routed correctly');
}

async function test_buildDispatchPlan_metadata_contains_symphonyDispatch() {
  const { buildDispatchPlan } = loadDispatcher();
  const plan = buildDispatchPlan({ id: 't3', title: '모니터링 체크', source: 'github' });
  assert.ok(plan.hubTaskPayload.metadata?.symphonyDispatch, 'symphonyDispatch metadata present');
  assert.ok(typeof plan.hubTaskPayload.metadata.symphonyDispatch.plannedAt === 'string');
  console.log('✅ buildDispatchPlan: symphonyDispatch metadata present');
}

// ─── validateDispatchPlan ────────────────────────────────────────────────────

async function test_validateDispatchPlan_valid_plan() {
  const { validateDispatchPlan } = loadDispatcher();
  const result = validateDispatchPlan({ targetTeam: 'claude', agent: 'dexter', confidence: 0.8 });
  assert.ok(result.ok);
  assert.strictEqual(result.blockers.length, 0);
  console.log('✅ validateDispatchPlan: valid plan passes');
}

async function test_validateDispatchPlan_invalid_team_blocker() {
  const { validateDispatchPlan } = loadDispatcher();
  const result = validateDispatchPlan({ targetTeam: 'unknown', agent: 'foo', confidence: 0.9 });
  assert.ok(!result.ok);
  assert.ok(result.blockers.some((b) => b.includes('invalid_target_team')));
  console.log('✅ validateDispatchPlan: invalid team → blocker');
}

async function test_validateDispatchPlan_missing_agent_blocker() {
  const { validateDispatchPlan } = loadDispatcher();
  const result = validateDispatchPlan({ targetTeam: 'claude', agent: '', confidence: 0.8 });
  assert.ok(!result.ok);
  assert.ok(result.blockers.some((b) => b.includes('missing_agent_assignment')));
  console.log('✅ validateDispatchPlan: missing agent → blocker');
}

async function test_validateDispatchPlan_low_confidence_warning() {
  const { validateDispatchPlan } = loadDispatcher();
  const result = validateDispatchPlan({ targetTeam: 'claude', agent: 'orchestrator', confidence: 0.2 });
  assert.ok(result.warnings.some((w) => w.includes('low_dispatch_confidence')));
  console.log('✅ validateDispatchPlan: low confidence → warning');
}

// ─── 실행 ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Symphony Team Dispatcher 테스트 시작 ===\n');
  const tests = [
    test_normalizeTicket_flat_input,
    test_normalizeTicket_invalid_source_falls_back_to_hub,
    test_normalizeTicket_invalid_priority_falls_back_to_normal,
    test_normalizeTicket_nested_ticket_field,
    test_normalizeTicket_labels_merged_from_ticket_and_root,
    test_inferTargetTeam_explicit_team_field,
    test_inferTargetTeam_team_label,
    test_inferTargetTeam_keyword_blog,
    test_inferTargetTeam_keyword_luna_trading,
    test_inferTargetTeam_keyword_ska_reservation,
    test_inferTargetTeam_keyword_darwin_research,
    test_inferTargetTeam_default_claude_for_unknown,
    test_inferTargetTeam_invalid_explicit_falls_to_keyword,
    test_inferAgent_explicit_agent,
    test_inferAgent_non_claude_team_returns_team_lead,
    test_inferAgent_security_keyword_to_guardian,
    test_inferAgent_build_keyword_to_builder,
    test_inferAgent_monitor_keyword_to_dexter,
    test_inferAgent_repair_keyword_to_doctor,
    test_buildDispatchPlan_luna_ticket,
    test_buildDispatchPlan_blog_ticket,
    test_buildDispatchPlan_metadata_contains_symphonyDispatch,
    test_validateDispatchPlan_valid_plan,
    test_validateDispatchPlan_invalid_team_blocker,
    test_validateDispatchPlan_missing_agent_blocker,
    test_validateDispatchPlan_low_confidence_warning,
  ];

  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t();
      passed++;
    } catch (e) {
      console.error(`❌ ${t.name}: ${e.message}`);
      failed++;
    }
  }

  console.log(`\n결과: ${passed}/${tests.length} 통과`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
