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
  code:      require('../lib/checks/code'),
  database:  require('../lib/checks/database'),
  security:  require('../lib/checks/security'),
  logs:      require('../lib/checks/logs'),
  bots:      require('../lib/checks/bots'),
  resources: require('../lib/checks/resources'),
  network:   require('../lib/checks/network'),
  ska:       require('../lib/checks/ska'),
  deps:      require('../lib/checks/deps'),
};

const { printReport, buildTelegramText, writeLog, writeFixLog } = require('../lib/reporter');

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
    () => checks.logs.run(),
    () => checks.security.run(),
    () => checks.database.run(),
    () => checks.code.run(),
    () => checks.deps.run(FULL),
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

  const elapsed = Date.now() - start;

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

  // 텔레그램: 오류/경고 있을 때만 발송
  if (TELEGRAM) {
    const hasIssue = results.some(r => r.status !== 'ok');
    if (hasIssue) {
      const text = buildTelegramText(results, elapsed);
      if (!SILENT) console.log('✅ 제이 큐 발행');

      const criticals = results.filter(r => r.status === 'critical');
      const errors    = results.filter(r => r.status === 'error');
      const level     = criticals.length > 0 ? 4 : errors.length > 0 ? 3 : 2;
      publishToMainBot({
        from_bot: 'dexter', event_type: 'system', alert_level: level,
        message: `덱스터 점검 결과: ${criticals.length}개 CRITICAL, ${errors.length}개 오류\n${text.split('\n')[0]}`,
        payload: { criticals: criticals.length, errors: errors.length },
      });
    } else {
      if (!SILENT) console.log('  ✅ 이상 없음 — 텔레그램 발송 생략');
    }
  }

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

} else {
  // 기본 점검 모드
  if (!SILENT) console.log(`\n🤖 ${BOT_NAME} (Dexter) 가동...\n`);
  main().catch(e => {
    console.error(`❌ ${BOT_NAME} 오류:`, e.message);
    process.exit(1);
  });
}
