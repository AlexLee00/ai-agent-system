// @ts-nocheck
'use strict';

/**
 * scripts/claude-daily-report.ts — 클로드팀 일일 리포트 실행 스크립트
 *
 * 실행: launchd ai.claude.daily-report (매일 06:30 KST)
 * Kill Switch: CLAUDE_TELEGRAM_ENHANCED=true (기본 false)
 *
 * 데이터 소스:
 *   - claude_doctor_recovery_log (PostgreSQL)
 *   - Dexter 로그 파일
 *   - launchctl 서비스 상태
 *   - Codex Notifier 상태 파일
 */

process.env.PG_DIRECT = process.env.PG_DIRECT || 'true';

const path    = require('path');
const os      = require('os');
const fs      = require('fs');
const { execSync } = require('child_process');

const reporter = require('../lib/telegram-reporter');
const pgPool   = require('../../../packages/core/lib/pg-pool');
const kst      = require('../../../packages/core/lib/kst');

const STATE_FILE = path.join(os.homedir(), '.openclaw', 'workspace', 'codex-notifier-state.json');

// ─── 추가 통계 수집 ────────────────────────────────────────────────────

async function fetchQualityStats() {
  try {
    const rows = await pgPool.query('reservation', `
      SELECT action, success, COUNT(*) AS cnt
      FROM claude_doctor_recovery_log
      WHERE inserted_at >= NOW() - INTERVAL '24 hours'
        AND action IN ('run_reviewer', 'run_guardian', 'run_builder')
      GROUP BY action, success
    `);

    const stats = { review_pass: true, guardian_pass: true, build_pass: true };
    for (const r of (rows || [])) {
      if (!r.success) {
        if (r.action === 'run_reviewer')  stats.review_pass  = false;
        if (r.action === 'run_guardian')  stats.guardian_pass = false;
        if (r.action === 'run_builder')   stats.build_pass   = false;
      }
    }
    return stats;
  } catch {
    return null;
  }
}

async function fetchCodexStats() {
  try {
    let activeCount = 0;
    let phasesCompleted = 0;

    // 활성 코덱스 프로세스 카운트
    try {
      const ps = execSync(
        "ps aux | grep -E 'claude.*CODEX|claude.*codex|claude.*--print' | grep -v grep | grep -v 'codex-notifier'",
        { encoding: 'utf8', timeout: 5000, stdio: 'pipe' }
      ).trim();
      activeCount = ps ? ps.split('\n').filter(Boolean).length : 0;
    } catch {
      activeCount = 0;
    }

    // 상태 파일에서 완료 Phase 수
    if (fs.existsSync(STATE_FILE)) {
      try {
        const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        for (const exec of Object.values(state)) {
          phasesCompleted += (exec.completed_phases || []).length;
        }
      } catch {}
    }

    return { active_count: activeCount, phases_completed: phasesCompleted };
  } catch {
    return null;
  }
}

async function fetchTestStats() {
  try {
    const result = execSync(
      'cd /Users/alexlee/projects/ai-agent-system && npm test --workspace=bots/claude 2>&1 | tail -5',
      { encoding: 'utf8', timeout: 30000, stdio: 'pipe' }
    );
    const totalMatch    = result.match(/(\d+)\s+(?:test|passing)/i);
    const failMatch     = result.match(/(\d+)\s+fail/i);
    return {
      total:      totalMatch  ? Number(totalMatch[1])  : 0,
      failures:   failMatch   ? Number(failMatch[1])   : 0,
      regression: failMatch   ? Number(failMatch[1]) > 0 : false,
    };
  } catch {
    return null;
  }
}

// ─── 메인 ────────────────────────────────────────────────────────────────

async function main() {
  const enabled = process.env.CLAUDE_TELEGRAM_ENHANCED === 'true';

  console.log(`[claude-daily-report] 시작 — ${kst.now().toLocaleString('ko-KR')}`);
  console.log(`[claude-daily-report] CLAUDE_TELEGRAM_ENHANCED: ${enabled ? 'ON' : 'OFF'}`);

  try {
    const [recoveries, quality, codex, tests] = await Promise.allSettled([
      (async () => {
        const rows = await pgPool.query('reservation', `
          SELECT action, success, attempts
          FROM claude_doctor_recovery_log
          WHERE inserted_at >= NOW() - INTERVAL '24 hours'
          ORDER BY inserted_at DESC
          LIMIT 20
        `);
        return rows || [];
      })(),
      fetchQualityStats(),
      fetchCodexStats(),
      fetchTestStats(),
    ]);

    const recoveriesData = recoveries.status === 'fulfilled' ? recoveries.value : [];
    const successCount   = recoveriesData.filter(r => r.success).length;
    const failCount      = recoveriesData.length - successCount;

    const stats = {
      dexter: {
        checks_run:   24,
        errors_found: failCount,
        auto_fixed:   successCount,
      },
      quality:    quality.status === 'fulfilled'   ? quality.value   : null,
      codex:      codex.status === 'fulfilled'     ? codex.value     : null,
      tests:      tests.status === 'fulfilled'     ? tests.value     : null,
      recoveries: recoveriesData.slice(0, 5),
    };

    const msg = reporter.formatDailyReport(stats);
    console.log(msg.replace(/\*/g, '').replace(/_/g, ''));

    if (enabled) {
      await reporter.onDailyReport(stats);
      console.log('[claude-daily-report] Telegram 발송 완료');
    } else {
      console.log('[claude-daily-report] Kill Switch OFF — Telegram 스킵');
    }

    process.exit(0);
  } catch (e) {
    console.error('[claude-daily-report] 오류:', e.message);
    process.exit(1);
  }
}

main();
