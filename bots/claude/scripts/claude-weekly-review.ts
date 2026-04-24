// @ts-nocheck
'use strict';

/**
 * scripts/claude-weekly-review.ts — 클로드팀 주간 리뷰 실행 스크립트
 *
 * 실행: launchd ai.claude.weekly-report (매주 일요일 19:00 KST)
 * Kill Switch: CLAUDE_TELEGRAM_ENHANCED=true (기본 false)
 *
 * 데이터 소스:
 *   - claude_doctor_recovery_log 7일치 (PostgreSQL)
 *   - 에이전트 launchd 상태
 *   - NLP 학습 패턴 파일
 *   - Emergency 모드 이력
 */

process.env.PG_DIRECT = process.env.PG_DIRECT || 'true';

const path    = require('path');
const os      = require('os');
const fs      = require('fs');
const { execSync } = require('child_process');

const reporter = require('../lib/telegram-reporter');
const pgPool   = require('../../../packages/core/lib/pg-pool');
const kst      = require('../../../packages/core/lib/kst');

const AGENTS = [
  { name: '덱스터',    label: 'ai.claude.dexter.quick' },
  { name: '아처',      label: 'ai.claude.archer' },
  { name: '닥터',      label: 'ai.claude.commander' },
  { name: '리뷰어',   label: 'ai.claude.reviewer' },
  { name: '가디언',   label: 'ai.claude.guardian' },
  { name: '빌더',     label: 'ai.claude.builder' },
  { name: '알림봇',   label: 'ai.claude.codex-notifier' },
  { name: '자동개발', label: 'ai.claude.auto-dev' },
];

// ─── 통계 수집 ────────────────────────────────────────────────────────

async function fetchWeeklySummary() {
  try {
    const rows = await pgPool.query('reservation', `
      SELECT
        COUNT(*)                                        AS total,
        SUM(CASE WHEN success THEN 1 ELSE 0 END)       AS success_count,
        ROUND(AVG(attempts), 1)                        AS avg_attempts,
        COUNT(DISTINCT action)                         AS unique_actions
      FROM claude_doctor_recovery_log
      WHERE inserted_at >= NOW() - INTERVAL '7 days'
    `);

    const row    = rows?.[0] || {};
    const total   = Number(row.total || 0);
    const success = Number(row.success_count || 0);
    const rate    = total > 0 ? Math.round((success / total) * 100) : 0;

    return {
      total_recoveries: total,
      success_rate:     rate,
      avg_attempts:     Number(row.avg_attempts || 1),
      unique_actions:   Number(row.unique_actions || 0),
      reviews_done:     0,
      security_scans:   0,
      builds_done:      0,
    };
  } catch {
    return null;
  }
}

async function fetchActionBreakdown() {
  try {
    const rows = await pgPool.query('reservation', `
      SELECT action, COUNT(*) AS cnt,
             SUM(CASE WHEN success THEN 1 ELSE 0 END) AS success_cnt
      FROM claude_doctor_recovery_log
      WHERE inserted_at >= NOW() - INTERVAL '7 days'
      GROUP BY action
      ORDER BY cnt DESC
      LIMIT 10
    `);
    return rows || [];
  } catch {
    return [];
  }
}

function fetchAgentStatus() {
  const result = {};
  for (const agent of AGENTS) {
    try {
      const out = execSync(`launchctl list '${agent.label}' 2>/dev/null`, {
        encoding: 'utf8', timeout: 3000, stdio: 'pipe',
      });
      const running = out.includes('"PID"') || out.includes('"LastExitStatus" = 0');
      result[agent.name] = { status: running ? '정상' : '중단', running };
    } catch {
      result[agent.name] = { status: '미설치', running: false };
    }
  }
  return result;
}

async function fetchNlpStats() {
  try {
    const patternFile = path.join(
      os.homedir(),
      '.openclaw', 'workspace', 'claude-intent-patterns.json'
    );
    if (!fs.existsSync(patternFile)) return null;
    const patterns = JSON.parse(fs.readFileSync(patternFile, 'utf8'));
    const allPatterns = Object.values(patterns).flat();
    return {
      learned_patterns: allPatterns.length,
      unrecognized:     0,
    };
  } catch {
    return null;
  }
}

function formatWeeklyStats(summary, actions, agents, nlp) {
  const lines = ['📅 클로드팀 주간 리뷰', kst.toKST(new Date()), ''];

  // 주간 요약
  if (summary) {
    lines.push('📊 복구 통계 (7일):');
    lines.push(`  총 복구: ${summary.total_recoveries}건`);
    lines.push(`  성공률: ${summary.success_rate}%`);
    lines.push(`  평균 시도: ${summary.avg_attempts}회`);
    lines.push(`  고유 액션: ${summary.unique_actions}종`);
    lines.push('');
  }

  // Top 액션
  if (actions && actions.length > 0) {
    lines.push('🔧 Top 복구 액션:');
    for (const r of actions.slice(0, 5)) {
      const rate = Number(r.cnt) > 0
        ? Math.round((Number(r.success_cnt) / Number(r.cnt)) * 100)
        : 0;
      lines.push(`  ${r.action}: ${r.cnt}회 (성공률 ${rate}%)`);
    }
    lines.push('');
  }

  // 에이전트 상태
  if (agents && Object.keys(agents).length > 0) {
    const runningAgents = Object.values(agents).filter(a => a.running).length;
    lines.push(`🤖 에이전트 (${runningAgents}/${Object.keys(agents).length} 가동):`);
    for (const [name, data] of Object.entries(agents)) {
      lines.push(`  ${data.running ? '✅' : '❌'} ${name}: ${data.status}`);
    }
    lines.push('');
  }

  // NLP
  if (nlp) {
    lines.push('🧠 NLP 학습:');
    lines.push(`  학습 패턴: ${nlp.learned_patterns}개`);
    lines.push('');
  }

  return lines.join('\n');
}

// ─── 메인 ────────────────────────────────────────────────────────────────

async function main() {
  const enabled = process.env.CLAUDE_TELEGRAM_ENHANCED === 'true';

  console.log(`[claude-weekly-review] 시작 — ${kst.toKST(new Date())}`);
  console.log(`[claude-weekly-review] CLAUDE_TELEGRAM_ENHANCED: ${enabled ? 'ON' : 'OFF'}`);

  try {
    const [summary, actions, nlp] = await Promise.allSettled([
      fetchWeeklySummary(),
      fetchActionBreakdown(),
      fetchNlpStats(),
    ]);

    const summaryData = summary.status === 'fulfilled' ? summary.value : null;
    const actionsData = actions.status === 'fulfilled' ? actions.value : [];
    const nlpData     = nlp.status === 'fulfilled'     ? nlp.value     : null;
    const agentsData  = fetchAgentStatus();

    const msg = formatWeeklyStats(summaryData, actionsData, agentsData, nlpData);
    console.log(msg);

    if (enabled) {
      await reporter.onWeeklyReview({
        week_summary: summaryData || {},
        agents:       agentsData,
        nlp:          nlpData,
      });
      console.log('[claude-weekly-review] Telegram 발송 완료');
    } else {
      console.log('[claude-weekly-review] Kill Switch OFF — Telegram 스킵');
    }

    process.exit(0);
  } catch (e) {
    console.error('[claude-weekly-review] 오류:', e.message);
    process.exit(1);
  }
}

main();
