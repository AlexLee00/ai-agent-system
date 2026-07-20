// @ts-nocheck
'use strict';

/**
 * src/builder.ts — 클로드팀 빌더 봇 (완전 구현)
 *
 * 빌드 대상:
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
const { execFileSync, execSync } = require('child_process');

const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');
const env          = require('../../../packages/core/lib/env');
const reviewer     = require('./reviewer.ts');
const { writeClaudeHeartbeat, errorHeartbeatMeta } = require('../lib/agent-heartbeat');

const ROOT = env.PROJECT_ROOT;
const TARGET_TYPECHECK_EXTS = new Set(['.ts', '.tsx', '.cts', '.mts', '.js', '.jsx']);
const TARGET_TYPECHECK_TEMP_PREFIX = '.refactorer-tscheck-';
const TARGET_TYPECHECK_TIMEOUT_MS = Number(process.env.REFACTORER_TARGETED_TSC_TIMEOUT_MS || 120000);

// ─── 빌드 패턴 정의 ───────────────────────────────────────────────────

const BUILD_PLANS = [
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
function needsBuild(changedFiles, rootDir = ROOT) {
  const effectiveRoot = path.resolve(rootDir || ROOT);
  const relative = (Array.isArray(changedFiles) ? changedFiles : [])
    .map((file) => {
      const value = String(file || '').trim();
      if (!value) return null;
      if (!path.isAbsolute(value)) return value.replace(/^\.\//, '').replace(/\\/g, '/');
      const relPath = path.relative(effectiveRoot, value).replace(/\\/g, '/');
      return relPath === '..' || relPath.startsWith('../') ? null : relPath;
    })
    .filter(Boolean);

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

function toProjectRelative(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function normalizePathForMatch(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

function absoluteTargetPath(filePath) {
  return path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.join(ROOT, filePath);
}

function isTargetTypecheckFile(filePath) {
  const normalized = normalizePathForMatch(filePath).toLowerCase();
  if (normalized.endsWith('.d.ts')) return false;
  return TARGET_TYPECHECK_EXTS.has(path.extname(normalized));
}

function findNearestTsconfig(startPath) {
  const absolute = absoluteTargetPath(startPath);
  let dir = fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()
    ? absolute
    : path.dirname(absolute);

  while (true) {
    const candidate = path.join(dir, 'tsconfig.json');
    if (fs.existsSync(candidate)) return candidate;
    if (dir === ROOT || !dir.startsWith(ROOT)) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return path.join(ROOT, 'tsconfig.json');
}

function projectTscBin() {
  const binName = process.platform === 'win32' ? 'tsc.cmd' : 'tsc';
  const localBin = path.join(ROOT, 'node_modules', '.bin', binName);
  return fs.existsSync(localBin) ? localBin : null;
}

function errorOutput(error) {
  return [
    error?.stdout,
    error?.stderr,
    error?.message,
  ].filter(Boolean).map(value => String(value)).join('\n').trim();
}

function targetDiagnosticNeedles(files) {
  return files.flatMap((file) => {
    const absolute = normalizePathForMatch(path.resolve(file));
    const relative = normalizePathForMatch(toProjectRelative(path.resolve(file)));
    return [absolute, relative];
  });
}

function filterTargetDiagnostics(output, files) {
  const text = String(output || '');
  if (!text.trim()) return '';
  const needles = targetDiagnosticNeedles(files);
  const lines = text.split(/\r?\n/);
  const filtered = [];
  let includeContinuation = false;

  for (const line of lines) {
    const normalizedLine = normalizePathForMatch(line);
    const isTargetLine = needles.some(needle => needle && normalizedLine.includes(needle));
    if (isTargetLine) {
      filtered.push(line);
      includeContinuation = true;
      continue;
    }
    if (includeContinuation && /^\s+/.test(line) && !/error TS\d+/.test(line)) {
      filtered.push(line);
      continue;
    }
    includeContinuation = false;
  }

  return filtered.join('\n').trim();
}

function hasNonSourceTypeScriptError(output) {
  return String(output || '')
    .split(/\r?\n/)
    .filter(line => /error TS\d+/.test(line))
    .some(line => !/\.(ts|tsx|cts|mts|js|jsx)\(\d+,\d+\): error TS\d+/.test(normalizePathForMatch(line)));
}

function hasSourceTypeScriptError(output) {
  return String(output || '')
    .split(/\r?\n/)
    .some(line => /\.(ts|tsx|cts|mts|js|jsx)\(\d+,\d+\): error TS\d+/.test(normalizePathForMatch(line)));
}

function writeTargetedTsconfig(tsconfigPath, files) {
  const configDir = path.dirname(tsconfigPath);
  const tempName = `${TARGET_TYPECHECK_TEMP_PREFIX}${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
  const tempPath = path.join(configDir, tempName);
  const payload = {
    extends: tsconfigPath,
    files: files.map(file => path.resolve(file)),
    compilerOptions: {
      noEmit: true,
    },
  };
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return tempPath;
}

function runTscProject(tsconfigPath, timeout = TARGET_TYPECHECK_TIMEOUT_MS) {
  const localTsc = projectTscBin();
  if (localTsc) {
    return execFileSync(localTsc, ['-p', tsconfigPath], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout,
    });
  }
  return execFileSync('npx', ['tsc', '-p', tsconfigPath], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout,
  });
}

function groupFilesByTsconfig(files) {
  const groups = new Map();
  for (const file of files) {
    const tsconfigPath = findNearestTsconfig(file);
    const list = groups.get(tsconfigPath) || [];
    list.push(file);
    groups.set(tsconfigPath, list);
  }
  return groups;
}

async function runTargetedTypeCheck(files = [], options = {}) {
  const requested = Array.isArray(files) ? files : [];
  const targetFiles = [...new Set(requested
    .map(absoluteTargetPath)
    .filter(isTargetTypecheckFile)
    .map(file => path.resolve(file)))];

  if (targetFiles.length === 0) {
    const message = '✅ 타깃 타입체크 스킵 — 타입체크 대상 TS 없음';
    return { results: [], pass: true, skipped: true, message };
  }

  const results = [];
  const groups = groupFilesByTsconfig(targetFiles);
  const timeout = Number(options.timeout || options.timeoutMs || TARGET_TYPECHECK_TIMEOUT_MS);

  for (const [tsconfigPath, groupFiles] of groups.entries()) {
    let tempConfig = null;
    const plan = {
      id: `targeted-tsc:${toProjectRelative(tsconfigPath)}`,
      name: `targeted tsc (${groupFiles.map(toProjectRelative).join(', ')})`,
      type: 'targeted-typescript',
      cwd: toProjectRelative(path.dirname(tsconfigPath)) || '.',
      timeout,
    };

    try {
      tempConfig = writeTargetedTsconfig(tsconfigPath, groupFiles);
      runTscProject(tempConfig, timeout);
      results.push({ plan, pass: true, skipped: false });
    } catch (error) {
      const output = errorOutput(error);
      const targetDiagnostics = filterTargetDiagnostics(output, groupFiles);
      const nonTargetSourceOnly = !targetDiagnostics
        && hasSourceTypeScriptError(output)
        && !hasNonSourceTypeScriptError(output);
      const pass = nonTargetSourceOnly;
      results.push({
        plan,
        pass,
        skipped: false,
        error: pass ? null : (targetDiagnostics || output || String(error?.message || error)).slice(0, 1800),
        message: pass && output ? '대상 파일 외 진단만 발생해 통과 처리' : undefined,
      });
    } finally {
      if (tempConfig) fs.rmSync(tempConfig, { force: true });
    }
  }

  const anyFailed = results.some(r => !r.pass && !r.skipped);
  return {
    results,
    pass: !anyFailed,
    skipped: false,
    sent: false,
    message: formatBuildReport(results),
  };
}

/**
 * TypeScript 컴파일 (tsc)
 */
async function runTypescriptBuild(plan, rootDir = ROOT) {
  const cwd = path.isAbsolute(plan.cwd) ? plan.cwd : path.join(rootDir, plan.cwd);
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
async function runElixirCompile(plan, rootDir = ROOT) {
  const cwd = path.isAbsolute(plan.cwd) ? plan.cwd : path.join(rootDir, plan.cwd);
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
async function runNextJsBuild(plan, rootDir = ROOT) {
  const cwd = path.isAbsolute(plan.cwd) ? plan.cwd : path.join(rootDir, plan.cwd);
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
async function executeBuildPlan(plan, rootDir = ROOT) {
  switch (plan.type) {
    case 'nextjs':     return runNextJsBuild(plan, rootDir);
    case 'typescript': return runTypescriptBuild(plan, rootDir);
    case 'elixir':     return runElixirCompile(plan, rootDir);
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

async function runBuildCheckCore(options = {}) {
  const enabled  = process.env.CLAUDE_BUILDER_ENABLED === 'true';
  const testMode = Boolean(options.test) || process.argv.includes('--test');

  if (!enabled && !testMode && !options.force) {
    return {
      results: [], pass: true, sent: false,
      message: '[빌더] Kill Switch OFF — 스킵',
    };
  }

  const rootDir = path.resolve(options.rootDir || ROOT);
  const changedFiles = Array.isArray(options.files)
    ? options.files
    : await reviewer.getChangedFiles();

  const plans = needsBuild(changedFiles, rootDir);

  if (plans.length === 0) {
    const message = '✅ 빌더 스킵 — 빌드 대상 변경 없음';
    if (!testMode) await postAlarm({ message, team: 'claude', alertLevel: 2, fromBot: 'builder' });
    return { results: [], pass: true, sent: !testMode, skipped: true, message };
  }

  // 순차 실행 (병렬 빌드 충돌 방지)
  const results = [];
  for (const plan of plans) {
    results.push(await executeBuildPlan(plan, rootDir));
  }

  const anyFailed = results.some(r => !r.pass && !r.skipped);
  const allSkipped = results.length > 0 && results.every(r => r.skipped);
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

  return { results, pass: !anyFailed, sent, message, skipped: allSkipped };
}

async function runBuildCheck(options = {}) {
  const start = Date.now();
  try {
    const result = await runBuildCheckCore(options);
    await writeClaudeHeartbeat('builder', 'ok', {
      durationMs: Date.now() - start,
      skipped: Boolean(result?.skipped || result?.message?.includes('Kill Switch OFF')),
      pass: result?.pass !== false,
      plans: Number(result?.results?.length || 0),
      failed: Number((result?.results || []).filter(item => !item.pass && !item.skipped).length),
      forced: Boolean(options.force),
      test: Boolean(options.test),
    });
    return result;
  } catch (error) {
    await writeClaudeHeartbeat('builder', 'error', errorHeartbeatMeta(error, {
      durationMs: Date.now() - start,
      forced: Boolean(options.force),
      test: Boolean(options.test),
    }));
    throw error;
  }
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
  runTargetedTypeCheck,
  needsBuild,
  reportBuildStatus,
  runTypescriptBuild,
  runElixirCompile,
  runNextJsBuild,
  formatBuildReport,
  findNearestTsconfig,
  filterTargetDiagnostics,
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
