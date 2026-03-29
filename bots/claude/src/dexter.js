#!/usr/bin/env node
'use strict';

/**
 * src/dexter.js — 덱스터 (Dexter) 시스템 유지보수 봇
 * 클로드팀 소속 / 주기 실행 (launchd)
 *
 * 사용법:
 *   node src/dexter.js                    # 기본 체크
 *   node src/dexter.js --full            # 전체 체크 (npm audit 포함)
 *   node src/dexter.js --telegram        # 이상 발견 시 텔레그램 알림
 *   node src/dexter.js --fix             # 자동 수정 가능 항목 처리
 *   node src/dexter.js --report-only     # 로그 기록만 (무음)
 *   node src/dexter.js --update-checksums # 코드 업데이트 후 체크섬 베이스라인 갱신
 *   node src/dexter.js --daily-report    # 일일 보고 (텔레그램 발송)
 */

const fs      = require('fs');
const cfg     = require('../lib/config');
const teamBus = require('../lib/team-bus');
const { publishToMainBot } = require('../lib/mainbot-client');

// ── 봇 이름 (변경 시 이 상수만 수정)
const BOT_NAME = '덱스터';

// ─── 체크 모듈 ─────────────────────────────────────────────────────
const checks = {
  code:           require('../lib/checks/code'),
  database:       require('../lib/checks/database'),
  security:       require('../lib/checks/security'),
  logs:           require('../lib/checks/logs'),
  bots:           require('../lib/checks/bots'),
  resources:      require('../lib/checks/resources'),
  network:        require('../lib/checks/network'),
  ska:            require('../lib/checks/ska'),
  heartbeat:      require('../lib/checks/heartbeat-check'),
  hub:            require('../lib/checks/hub'),
  healthState:    require('../lib/checks/health-state'),
  deps:           require('../lib/checks/deps'),
  patterns:       require('../lib/checks/patterns'),
  selfDiagnosis:  require('../lib/checks/self-diagnosis'),
  teamLeads:      require('../lib/checks/team-leads'),
  openclaw:       require('../lib/checks/openclaw'),
  llmCost:        require('../lib/checks/llm-cost'),
  billing:        require('../lib/checks/billing'),
  workspaceGit:   require('../lib/checks/workspace-git'),
  n8n:            require('../lib/checks/n8n'),
  botBehavior:    require('../lib/checks/bot-behavior'),
};

// ─── 이중 모드 관리자 ────────────────────────────────────────────────
const { DexterMode } = require('../lib/dexter-mode');
const dexterMode = new DexterMode();

const { saveErrorItems, markResolved, getNewErrors, cleanup: cleanupErrorHistory } = require('../lib/error-history');
const { analyzeWithAI } = require('../lib/ai-analyst');
const { evaluateWithClaudeLead, pollAgentEvents } = require('../lib/claude-lead-brain');

const { printReport, buildTelegramText, writeLog, writeFixLog, emitDexterEvent } = require('../lib/reporter');

// ─── 자동 수정 ─────────────────────────────────────────────────────
const autofix = require('../lib/autofix');

// ─── 전역 플래그 ────────────────────────────────────────────────────
const _args   = process.argv.slice(2);
const SILENT  = _args.includes('--report-only');

// ─── Self-lock ─────────────────────────────────────────────────────
function acquireLock() {
  const lock = cfg.LOCKS.dexter;
  if (fs.existsSync(lock)) {
    const old = fs.readFileSync(lock, 'utf8').trim();
    try { process.kill(Number(old), 0); console.error(`${BOT_NAME} 이미 실행 중 (PID: ${old})`); process.exit(1); }
    catch { fs.unlinkSync(lock); }
  }
  fs.writeFileSync(lock, String(process.pid));
  process.on('exit', () => { try { fs.unlinkSync(lock); } catch {} });
  ['SIGTERM','SIGINT'].forEach(s => process.on(s, () => process.exit(0)));
}

// ─── 메인 ───────────────────────────────────────────────────────────
async function main() {
  const FULL     = _args.includes('--full');
  const TELEGRAM = _args.includes('--telegram');
  const FIX      = _args.includes('--fix');

  acquireLock();

  // 팀버스: 시작 상태 등록
  try { teamBus.setStatus('dexter', 'running', '시스템 점검 중'); } catch { /* DB 없으면 무시 */ }

  const start   = Date.now();
  const results = [];

  // 체크 순서: 빠른 것 → 느린 것
  const runners = [
    () => checks.resources.run(),
    () => checks.network.run(),
    () => checks.bots.run(),
    () => checks.ska.run(),
    () => checks.heartbeat.run(),
    () => checks.hub.run(),
    () => checks.healthState.run(),
    () => checks.logs.run(),
    () => checks.security.run(),
    () => checks.database.run(),
    () => checks.code.run(),
    () => checks.deps.run(FULL),
    () => checks.teamLeads.run(),
    () => checks.openclaw.run(),
    () => checks.llmCost.run(),
    () => checks.billing.run(),
    () => checks.workspaceGit.run(),
    () => checks.n8n.run(),
  ];

  for (const run of runners) {
    try {
      const r = await run();
      results.push(r);
      if (!SILENT) process.stdout.write(`  ${r.status === 'ok' ? '✅' : r.status === 'warn' ? '⚠️' : '❌'} ${r.name}\n`);
      // 팀버스: 체크 이력 기록
      try {
        const errorCount = (r.items || []).filter(i => i.status === 'error').length;
        teamBus.recordCheck({
          checkName:  r.name,
          status:     r.status,
          itemCount:  (r.items || []).length,
          errorCount,
          detail:     errorCount > 0 ? (r.items || []).filter(i => i.status === 'error').map(i => i.label).slice(0, 5) : null,
        });
      } catch { /* 무시 */ }
    } catch (e) {
      results.push({ name: '체크 실행 오류', status: 'error', items: [{ label: e.message, status: 'error', detail: '' }] });
    }
  }

  // 인프라 상태 기반 이중 모드 전환 판단
  // Emergency 조건: OpenClaw 게이트웨이 or 스카야 텔레그램 봇 3분 이상 다운
  try {
    // 덱스터 실행 = 팀장(클로드) 활성 증거 → checkModeTransition 전에 갱신
    // (이전: evaluateWithClaudeLead 내부에서만 갱신 → 1시간 주기 실행 시 항상 stale → emergency 자동 해제 불가 버그)
    dexterMode.updateClaudeLeadActivity();

    const { isOpenClawOk, isSkayaOk } = require('../lib/checks/team-leads');
    const teamLeadsResult = results.find(r => r.name === '핵심 봇 프로세스 건강');
    const openclawOk      = isOpenClawOk(teamLeadsResult);
    const skayaOk         = isSkayaOk(teamLeadsResult);

    const { flushed } = dexterMode.checkModeTransition(openclawOk, skayaOk);

    // Phase 2: 팀장 무응답 Emergency 체크 (인프라 기반 전환과 별개)
    dexterMode.checkEmergencyCondition();

    // Phase 2: DB 기반 팀장 무응답 보완 체크 (파일 기반과 이중 검증)
    try {
      const dbSt = await dexterMode.checkClaudeLeadDbStatus();
      if (dbSt?.isStale) {
        console.warn(`  ⚠️ [Phase 2] DB 기반 클로드(팀장) 무응답 감지 — 마지막 업데이트: ${dbSt.updatedAt}`);
      }
    } catch { /* 무시 */ }

    if (dexterMode.isEmergency()) {
      console.log('⚠️ 덱스터 비상 모드 — 텔레그램 보고 불가, 로컬 파일에 기록 중');
    }
    // 비상 모드 해제 시 밀린 알림 일괄 발송
    if (flushed.length > 0) {
      try {
        const { publishToMainBot } = require('../lib/mainbot-client');
        publishToMainBot({
          from_bot:    'dexter',
          event_type:  'system',
          alert_level: 2,
          message:     `✅ 덱스터 비상 모드 해제\n밀린 알림 ${flushed.length}건 전송:\n` +
                       flushed.map(a => `• ${a.message}`).join('\n').slice(0, 800),
          payload:     { flushed_count: flushed.length },
        });
      } catch { /* 발송 실패 무시 */ }
    }
  } catch { /* 무시 */ }

  // ok로 돌아온 항목의 과거 오류 이력 삭제 (해결된 이슈 패턴 누적 방지)
  try { await markResolved(results); } catch { /* 무시 */ }
  // 오류 이력 저장 (패턴 분석용) — patterns 체크 실행 전에 저장
  try { await saveErrorItems(results); } catch { /* 무시 */ }
  // 7일 이상 된 이력 자동 삭제 (무한 누적 방지)
  try { await cleanupErrorHistory(7); } catch { /* 무시 */ }

  // 패턴 분석 체크 (이력 기반 — 항상 마지막 실행)
  try {
    const r = await checks.patterns.run();
    results.push(r);
    if (!SILENT) process.stdout.write(`  ${r.status === 'ok' ? '✅' : r.status === 'warn' ? '⚠️' : '❌'} ${r.name}\n`);
  } catch (e) {
    results.push({ name: '오류 패턴 분석', status: 'warn', items: [{ label: e.message, status: 'warn', detail: '' }] });
  }

  const elapsed = Date.now() - start;

  // 자기진단 (전체 결과 수집 후 — 항목 수 계산 필요)
  try {
    const totalItems = results.reduce((acc, r) => acc + (r.items || []).length, 0);
    const r = await checks.selfDiagnosis.run(totalItems);
    results.push(r);
    if (!SILENT) process.stdout.write(`  ${r.status === 'ok' ? '✅' : r.status === 'warn' ? '⚠️' : '❌'} ${r.name}\n`);
  } catch (e) {
    results.push({ name: '덱스터 자기진단', status: 'warn', items: [{ label: e.message, status: 'warn', detail: '' }] });
  }

  // 자동 수정
  if (FIX) {
    const fixes = await autofix.run(results);
    if (fixes.length > 0) {
      results.push({ name: '자동 수정', status: 'ok', items: fixes });
      writeFixLog(fixes);
    }
  }

  // 결과 출력
  if (!SILENT) printReport(results, { elapsed, full: FULL });

  // 로그 기록
  writeLog(results, elapsed);

  // 텔레그램: 신규 오류가 있을 때만 발송 (기존 반복 오류는 무시)
  let telegramSent = false;
  let telegramOk   = false;
  if (TELEGRAM) {
    const hasCritical = results.some(r => r.status === 'critical');
    const newErrors   = await getNewErrors(2, 7).catch(() => []);
    const hasNewIssue = hasCritical || newErrors.length > 0;
    if (hasNewIssue) {
      const text = buildTelegramText(results, elapsed);
      if (!SILENT) console.log('✅ 제이 큐 발행');

      const criticals  = results.filter(r => r.status === 'critical');
      const errors     = results.filter(r => r.status === 'error');
      const warns      = results.filter(r => r.status === 'warn');
      const level      = criticals.length > 0 ? 4 : errors.length > 0 ? 3 : 2;
      const statusIcon = criticals.length > 0 || errors.length > 0 ? '❌' : '⚠️';

      // ── AI 분석 ─────────────────────────────────────────────────
      let aiSection = '';
      try {
        const insight = await analyzeWithAI(results, elapsed, level);
        if (insight) {
          const TREND_ICON = { improving: '📈', stable: '📊', degrading: '📉' };
          aiSection = [
            '',
            `🧠 AI 진단: ${insight.diagnosis}`,
            insight.root_cause ? `🔍 원인: ${insight.root_cause}` : '',
            `${TREND_ICON[insight.trend] || '📊'} 추세: ${insight.trend}`,
            insight.prediction ? `⚡ 예측: ${insight.prediction}` : '',
            insight.action     ? `💡 권장: ${insight.action}` : '',
          ].filter(Boolean).join('\n');
        }
      } catch (e) {
        console.warn('  ⚠️ AI 분석 실패:', e.message);
      }

      try {
        publishToMainBot({
          from_bot: 'dexter', event_type: 'system', alert_level: level,
          message: [
            `🤖 덱스터 유지보수 리포트 ${statusIcon}`,
            `점검 결과: ${criticals.length}개 CRITICAL, ${errors.length}개 오류, ${warns.length}개 경고`,
            aiSection,
          ].filter(Boolean).join('\n'),
          payload: { criticals: criticals.length, errors: errors.length, warns: warns.length },
        });
        telegramOk = true;
      } catch { /* 발송 실패 — recordRun에서 기록 */ }
      telegramSent = true;
    } else {
      if (!SILENT) console.log('  ✅ 이상 없음 — 텔레그램 발송 생략');
    }
  }

  // 자기진단 상태 기록 (다음 실행 시 비교용)
  try {
    const totalItems = results.reduce((acc, r) => acc + (r.items || []).length, 0);
    checks.selfDiagnosis.recordRun({ itemCount: totalItems, elapsedMs: elapsed, telegramSent, telegramOk });
  } catch { /* 무시 */ }

  // 팀버스: 완료 상태 갱신
  try {
    const hasError = results.some(r => r.status === 'error');
    if (hasError) {
      const errNames = results.filter(r => r.status === 'error').map(r => r.name).join(', ');
      teamBus.markError('dexter', `체크 오류: ${errNames}`);
    } else {
      teamBus.markDone('dexter');
    }
    teamBus.cleanupOldMessages();
  } catch { /* 무시 */ }

  // agent_events 발행 (이중 경로 — 팀장봇 event bus)
  await emitDexterEvent(results, elapsed);

  // Shadow: 클로드(팀장) Sonnet 종합 판단 (기존 보고에 영향 없음)
  try {
    await evaluateWithClaudeLead(results);
  } catch (e) {
    console.warn('⚠️ 클로드(팀장) Shadow 판단 실패 (무시):', e.message);
  }

  // agent_events 미처리 수신 이벤트 소화 (타 팀봇 → 클로드 팀장)
  try {
    await pollAgentEvents();
  } catch (e) {
    console.warn('⚠️ 팀장 이벤트 폴링 실패 (무시):', e.message);
  }

  // Phase 3: 독터 대기 태스크 처리 (팀장→독터 역할 분리)
  try {
    const doctor = require('../lib/doctor');
    await doctor.pollDoctorTasks();
  } catch (e) {
    console.warn('⚠️ 독터 태스크 처리 실패 (무시):', e.message);
  }

  // Emergency 폴백: 클로드(팀장) 무응답 시 직접 복구 (agent_tasks 루프 우회)
  // 정상 모드: 덱스터 → agent_tasks → 독터 (팀장 경유)
  // Emergency: 덱스터 → 독터 직접 호출 (팀장 무응답으로 tasks 생성 불가)
  if (dexterMode.isEmergency()) {
    try {
      const doctor      = require('../lib/doctor');
      const errorItems  = results.flatMap(r =>
        (r.items || [])
          .filter(i => i.status === 'error')
          .map(i => ({ checkName: r.name, label: i.label, status: i.status, detail: i.detail || '' }))
      );
      if (errorItems.length > 0) {
        const recoveries = await doctor.emergencyDirectRecover(errorItems, 'dexter-emergency');
        const succeeded  = recoveries.filter(r => r.success).length;
        if (recoveries.length > 0) {
          console.log(`  🚨 [Emergency 폴백] 복구 결과: ${succeeded}/${recoveries.length}건 성공`);
        }
      }
    } catch (e) {
      console.warn('⚠️ Emergency 폴백 직접 복구 실패 (무시):', e.message);
    }
  }

  // 종료 코드: 오류 있으면 1
  const hasError = results.some(r => r.status === 'error');
  process.exit(hasError ? 1 : 0);
}

// ─── 실행 분기 ──────────────────────────────────────────────────────
if (_args.includes('--daily-report')) {
  // 일일 보고 모드
  const dailyReport = require('../lib/daily-report');
  const telegram    = _args.includes('--telegram');
  dailyReport.run({ telegram, print: true })
    .then(() => process.exit(0))
    .catch(e => { console.error('❌ 일일 보고 오류:', e.message); process.exit(1); });

} else if (_args.includes('--update-checksums')) {
  // 체크섬 갱신 모드
  const { updateChecksums } = require('../lib/checks/code');
  const result = updateChecksums();
  console.log(`✅ 체크섬 갱신 완료: ${result.updated}개 파일`);
  if (result.missing.length > 0) {
    console.log(`⚠️  파일 없음 (${result.missing.length}개):`);
    result.missing.forEach(f => console.log(`   - ${f}`));
  }
  process.exit(0);

} else if (_args.includes('--clear-patterns')) {
  // 패턴 이력 초기화 모드
  // 사용법: --clear-patterns [--label=<label>] [--check=<체크명>] [--all]
  const { clearPatterns } = require('../lib/error-history');
  const labelArg = _args.find(a => a.startsWith('--label='))?.split('=')[1] || null;
  const checkArg = _args.find(a => a.startsWith('--check='))?.split('=')[1] || null;
  const allFlag  = _args.includes('--all');

  if (!allFlag && !labelArg && !checkArg) {
    console.log('사용법:');
    console.log('  --clear-patterns --label=<레이블 키워드>   특정 레이블 이력 삭제');
    console.log('  --clear-patterns --check=<체크 이름>       특정 체크 모듈 이력 삭제');
    console.log('  --clear-patterns --all                     전체 이력 삭제');
    process.exit(0);
  }

  clearPatterns(allFlag ? null : labelArg, allFlag ? null : checkArg, allFlag)
    .then(deleted => {
      const target = allFlag ? '전체' : labelArg ? `레이블: ${labelArg}` : `체크: ${checkArg}`;
      console.log(`✅ 패턴 이력 삭제 완료: ${target} — ${deleted}건`);
      process.exit(0);
    })
    .catch(e => {
      console.error(`❌ 패턴 이력 삭제 실패: ${e.message}`);
      process.exit(1);
    });

} else {
  // 기본 점검 모드
  if (!SILENT) console.log(`\n🤖 ${BOT_NAME} (Dexter) 가동...\n`);
  main().catch(e => {
    console.error(`❌ ${BOT_NAME} 오류:`, e.message);
    process.exit(1);
  });
}
