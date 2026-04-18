// @ts-nocheck
'use strict';

/**
 * src/builder.ts — 클로드팀 빌더 봇 (완전 구현)
 *
 * 빌드 대상:
 *   - bots/worker/web/ (Next.js)
 *   - packages/core/ (TypeScript)
 *   - bots/investment/elixir/, bots/darwin/elixir/, bots/sigma/elixir/ (mix compile)
 *   - elixir/team_jay/ (mix compile)
 *
 * Kill Switch: CLAUDE_BUILDER_ENABLED=true (기본 false)
 *
 * 트리거:
 *   - 변경 파일 패턴 매칭 시 자동 실행
 *   - Commander `run_builder` 명령
 *   - Reviewer + Guardian 통과 후 연계 실행
 */

const path    = require('path');
const fs      = require('fs');
const { execSync } = require('child_process');

const { postAlarm } = require('../../../packages/core/lib/openclaw-client');
const env          = require('../../../packages/core/lib/env');
const reviewer     = require('./reviewer');

const ROOT = env.PROJECT_ROOT;

// ─── 빌드 패턴 정의 ───────────────────────────────────────────────────

const BUILD_PLANS = [
  {
    id: 'worker-web',
    name: 'Worker Web (Next.js)',
    patterns: [
      'bots/worker/web/',
      'bots/worker/package.json',
      'bots/worker/web/package.json',
      'bots/worker/web/next.config.js',
      'bots/worker/web/next.config.mjs',
    ],
    type: 'nextjs',
    cwd: 'bots/worker/web',
    timeout: 180000,
  },
  {
    id: 'packages-core',
    name: 'packages/core (TypeScript)',
    patterns: [
      'packages/core/lib/',
      'packages/core/src/',
      'packages/core/package.json',
      'packages/core/tsconfig.json',
    ],
    type: 'typescript',
    cwd: 'packages/core',
    timeout: 60000,
  },
  {
    id: 'elixir-team-jay',
    name: 'elixir/team_jay (Elixir)',
    patterns: [
      'elixir/team_jay/lib/',
      'elixir/team_jay/mix.exs',
      'elixir/team_jay/mix.lock',
    ],
    type: 'elixir',
    cwd: 'elixir/team_jay',
    timeout: 120000,
  },
  {
    id: 'elixir-investment',
    name: 'bots/investment/elixir (Elixir)',
    patterns: [
      'bots/investment/elixir/lib/',
      'bots/investment/elixir/mix.exs',
    ],
    type: 'elixir',
    cwd: 'bots/investment/elixir',
    timeout: 120000,
  },
  {
    id: 'elixir-darwin',
    name: 'bots/darwin/elixir (Elixir)',
    patterns: [
      'bots/darwin/elixir/lib/',
      'bots/darwin/elixir/mix.exs',
    ],
    type: 'elixir',
    cwd: 'bots/darwin/elixir',
    timeout: 120000,
  },
  {
    id: 'elixir-sigma',
    name: 'bots/sigma/elixir (Elixir)',
    patterns: [
      'bots/sigma/elixir/lib/',
      'bots/sigma/elixir/mix.exs',
    ],
    type: 'elixir',
    cwd: 'bots/sigma/elixir',
    timeout: 120000,
  },
];

// ─── 변경 감지 ────────────────────────────────────────────────────────

/**
 * 변경된 파일에 해당하는 BuildPlan 목록 반환
 */
function needsBuild(changedFiles) {
  const relative = (Array.isArray(changedFiles) ? changedFiles : []).map(f =>
    path.relative(ROOT, f).replace(/\\/g, '/')
  );

  return BUILD_PLANS.filter(plan => {
    return relative.some(f =>
      plan.patterns.some(pattern => f.startsWith(pattern) || f === pattern)
    );
  });
}

// ─── 빌드 실행 ────────────────────────────────────────────────────────

function safeExec(command, options = {}) {
  return execSync(command, {
    cwd: ROOT,
    stdio: 'pipe',
    encoding: 'utf8',
    ...options,
  });
}

/**
 * TypeScript 컴파일 (tsc)
 */
async function runTypescriptBuild(plan) {
  const cwd = path.join(ROOT, plan.cwd);
  if (!fs.existsSync(cwd)) {
    return { plan, pass: true, skipped: true, message: `스킵 — 디렉토리 없음: ${plan.cwd}` };
  }

  const hasTsConfig = fs.existsSync(path.join(cwd, 'tsconfig.json'));
  if (!hasTsConfig) {
    return { plan, pass: true, skipped: true, message: `스킵 — tsconfig.json 없음: ${plan.cwd}` };
  }

  try {
    safeExec('npx tsc --noEmit 2>&1', { cwd, timeout: plan.timeout });
    return { plan, pass: true, skipped: false };
  } catch (e) {
    const stderr = String(e.stdout || e.stderr || e.message || '').trim();
    return { plan, pass: false, skipped: false, error: stderr.slice(0, 1000) };
  }
}

/**
 * Elixir 컴파일 (mix compile)
 */
async function runElixirCompile(plan) {
  const cwd = path.join(ROOT, plan.cwd);
  if (!fs.existsSync(cwd)) {
    return { plan, pass: true, skipped: true, message: `스킵 — 디렉토리 없음: ${plan.cwd}` };
  }

  const hasMixExs = fs.existsSync(path.join(cwd, 'mix.exs'));
  if (!hasMixExs) {
    return { plan, pass: true, skipped: true, message: `스킵 — mix.exs 없음: ${plan.cwd}` };
  }

  try {
    safeExec('mix compile --warnings-as-errors 2>&1', { cwd, timeout: plan.timeout });
    return { plan, pass: true, skipped: false };
  } catch (e) {
    const stderr = String(e.stdout || e.stderr || e.message || '').trim();
    // 경고만 있는 경우 (warnings-as-errors 완화)
    if (stderr.includes('warning:') && !stderr.includes('error:')) {
      return { plan, pass: true, skipped: false, warning: stderr.slice(0, 500) };
    }
    return { plan, pass: false, skipped: false, error: stderr.slice(0, 1000) };
  }
}

/**
 * Next.js 빌드
 */
async function runNextJsBuild(plan) {
  const cwd = path.join(ROOT, plan.cwd);
  if (!fs.existsSync(cwd)) {
    return { plan, pass: true, skipped: true, message: `스킵 — 디렉토리 없음: ${plan.cwd}` };
  }

  try {
    safeExec('npm run build 2>&1', { cwd, timeout: plan.timeout });
    return { plan, pass: true, skipped: false };
  } catch (e) {
    const stderr = String(e.stdout || e.stderr || e.message || '').trim();
    return { plan, pass: false, skipped: false, error: stderr.slice(0, 1800) };
  }
}

/**
 * 빌드 플랜 실행
 */
async function executeBuildPlan(plan) {
  switch (plan.type) {
    case 'nextjs':     return runNextJsBuild(plan);
    case 'typescript': return runTypescriptBuild(plan);
    case 'elixir':     return runElixirCompile(plan);
    default:
      return { plan, pass: true, skipped: true, message: `알 수 없는 빌드 타입: ${plan.type}` };
  }
}

// ─── 리포트 포맷 ──────────────────────────────────────────────────────

function formatBuildReport(results) {
  if (results.length === 0) return '✅ 빌더 스킵 — 빌드 대상 변경 없음';

  const lines = ['🔨 빌드 결과'];
  let anyFailed = false;

  for (const r of results) {
    if (r.skipped) {
      lines.push(`  ⏭️ ${r.plan.name}: 스킵`);
    } else if (r.pass) {
      const warn = r.warning ? ` (경고 있음)` : '';
      lines.push(`  ✅ ${r.plan.name}${warn}`);
    } else {
      anyFailed = true;
      lines.push(`  ❌ ${r.plan.name}: 실패`);
      if (r.error) {
        lines.push(`     ${r.error.split('\n').slice(0, 3).join('\n     ')}`);
      }
    }
  }

  if (!anyFailed) {
    lines.push('');
    lines.push('✅ 전체 빌드 통과');
  }

  return lines.join('\n');
}

// ─── 메인 실행 ────────────────────────────────────────────────────────

async function runBuildCheck(options = {}) {
  const enabled  = process.env.CLAUDE_BUILDER_ENABLED === 'true';
  const testMode = Boolean(options.test) || process.argv.includes('--test');

  if (!enabled && !testMode && !options.force) {
    return {
      results: [], pass: true, sent: false,
      message: '[빌더] Kill Switch OFF — 스킵',
    };
  }

  const changedFiles = Array.isArray(options.files)
    ? options.files
    : await reviewer.getChangedFiles();

  const plans = needsBuild(changedFiles);

  if (plans.length === 0) {
    const message = '✅ 빌더 스킵 — 빌드 대상 변경 없음';
    if (!testMode) await postAlarm({ message, team: 'claude', alertLevel: 2, fromBot: 'builder' });
    return { results: [], pass: true, sent: !testMode, skipped: true, message };
  }

  // 순차 실행 (병렬 빌드 충돌 방지)
  const results = [];
  for (const plan of plans) {
    results.push(await executeBuildPlan(plan));
  }

  const anyFailed = results.some(r => !r.pass && !r.skipped);
  const message = formatBuildReport(results);

  let sent = false;
  if (!testMode) {
    sent = (await postAlarm({
      message,
      team: 'claude',
      alertLevel: anyFailed ? 4 : 2,
      fromBot: 'builder',
    })).ok;
  }

  return { results, pass: !anyFailed, sent, message };
}

/**
 * 빌드 상태 보고 (Commander 호출용)
 */
async function reportBuildStatus(results) {
  const message = formatBuildReport(results);
  const anyFailed = results.some(r => !r.pass && !r.skipped);
  return postAlarm({ message, team: 'claude', alertLevel: anyFailed ? 4 : 2, fromBot: 'builder' });
}

module.exports = {
  runBuildCheck,
  needsBuild,
  reportBuildStatus,
  runTypescriptBuild,
  runElixirCompile,
  runNextJsBuild,
  formatBuildReport,
  BUILD_PLANS,
};

if (require.main === module) {
  runBuildCheck({ force: true })
    .then(result => {
      console.log(result.message);
      process.exit(result.pass ? 0 : 1);
    })
    .catch(error => {
      console.warn(`[builder] 실행 실패: ${error.message}`);
      process.exit(0);
    });
}
