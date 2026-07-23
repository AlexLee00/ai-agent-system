#!/usr/bin/env node
// @ts-nocheck

import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const require = createRequire(import.meta.url);
const pgPool = require(path.join(REPO_ROOT, 'packages/core/lib/pg-pool.js'));
const DEFAULT_PORT = 8774;
const HUB_BASE = 'http://localhost:7788';

export const CLAUDE_REFACTOR_MCP_TOOLS = [
  {
    name: 'analyze_tech_debt',
    description: '경로의 기술부채 분석. @ts-nocheck 비율, 대형 파일, 복잡도 측정.',
  },
  {
    name: 'suggest_refactoring',
    description: '파일의 리팩토링 전략 제안. 분할 계획, 타입 복구 로드맵.',
  },
  {
    name: 'split_large_file',
    description: '대형 파일 안전 분할 계획 생성. 책임별 모듈 추출 전략.',
  },
  {
    name: 'restore_types',
    description: '@ts-nocheck 점진적 제거 계획. 타입 에러 예상 목록.',
  },
  {
    name: 'verify_refactoring',
    description: '리팩토링 검증 (Static 분석). 라인 수 변화, @ts-nocheck 제거 확인.',
  },
  {
    name: 'score_pr',
    description: 'PR 번호별 Claude quality gate 점수 최신 기록을 조회한다(read-only).',
  },
  {
    name: 'pr_pipeline_status',
    description: 'Claude PR pipeline outcome/score 상태를 조회한다(read-only).',
  },
  {
    name: 'quality_gate',
    description: 'Claude quality gate 점수를 산출하고 가능하면 pr_review_scores에 best-effort 저장한다.',
  },
];

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function loadHubToken() {
  try {
    const store = JSON.parse(readFileSync(path.join(REPO_ROOT, 'bots/hub/secrets-store.json'), 'utf8'));
    return store.HUB_AUTH_TOKEN || '';
  } catch {
    return process.env.HUB_AUTH_TOKEN || '';
  }
}

async function hubFetch(pathname, options = {}) {
  const token = loadHubToken();
  const { method = 'GET', body } = options;
  try {
    const res = await fetch(`${HUB_BASE}${pathname}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function countTsNocheck(targetPath) {
  try {
    const result = execSync(
      `grep -r "@ts-nocheck" "${targetPath}" --include="*.ts" -l 2>/dev/null | wc -l`,
      { encoding: 'utf8' }
    );
    return parseInt(result.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function countTsFiles(targetPath) {
  try {
    const result = execSync(
      `find "${targetPath}" -name "*.ts" -not -path "*/node_modules/*" -not -path "*/venv/*" 2>/dev/null | wc -l`,
      { encoding: 'utf8' }
    );
    return parseInt(result.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function getLargeFiles(targetPath, thresholdLines = 500) {
  try {
    const result = execSync(
      `find "${targetPath}" -name "*.ts" -not -path "*/node_modules/*" -not -path "*/venv/*" 2>/dev/null | xargs wc -l 2>/dev/null | sort -rn | awk '$1 > ${thresholdLines} && $2 != "total"' | head -20`,
      { encoding: 'utf8' }
    );
    return result.trim().split('\n').filter(Boolean).map((line) => {
      const parts = line.trim().split(/\s+/);
      return { lines: parseInt(parts[0], 10), file: parts.slice(1).join(' ') };
    });
  } catch {
    return [];
  }
}

function getFileLineCount(filePath) {
  try {
    const result = execSync(`wc -l < "${filePath}" 2>/dev/null`, { encoding: 'utf8' });
    return parseInt(result.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function hasTsNocheck(filePath) {
  try {
    const content = readFileSync(filePath, 'utf8');
    return content.includes('@ts-nocheck');
  } catch {
    return false;
  }
}

function estimateFunctions(filePath) {
  try {
    const result = execSync(
      `grep -c "^\\s*\\(export\\s\\+\\)\\?\\(async\\s\\+\\)\\?function\\|=>\\s*{" "${filePath}" 2>/dev/null`,
      { encoding: 'utf8' }
    );
    return parseInt(result.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

export async function handleTool(name, params) {
  if (name === 'quality_gate') {
    try {
      const qualityGate = await import(pathToFileURL(path.join(REPO_ROOT, 'bots/claude/a2a/skills/quality-gate.ts')).href);
      const result = await qualityGate.runQualityGate(params || {});
      return { ok: result?.status === 'completed', result, ...(result?.output || {}) };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  if (name === 'score_pr') {
    const prNumber = Math.floor(Number(params.prNumber || params.pr_number || params.number || 0));
    if (!prNumber) return { ok: false, error: 'prNumber is required' };
    try {
      const rows = await pgPool.queryReadonly('claude', `
        SELECT pr_number, build_score, review_score, guard_score, total, verdict, created_at
        FROM claude.pr_review_scores
        WHERE pr_number = $1
        ORDER BY created_at DESC
        LIMIT 5
      `, [prNumber]);
      return { ok: true, prNumber, rows };
    } catch (err) {
      return { ok: true, skipped: true, reason: 'pr_review_scores_unavailable', error: String(err?.message || err) };
    }
  }

  if (name === 'pr_pipeline_status') {
    const limit = Math.max(1, Math.min(50, Number(params.limit || 10) || 10));
    try {
      const rows = await pgPool.queryReadonly('claude', `
        SELECT id, job_id, rel_path, outcome, stage, pr_number, pr_url, created_at
        FROM claude.auto_dev_outcomes
        WHERE pr_number IS NOT NULL OR pr_url IS NOT NULL OR (meta -> 'prWorkflow') IS NOT NULL
        ORDER BY created_at DESC
        LIMIT $1
      `, [limit]);
      return { ok: true, limit, rows };
    } catch (err) {
      return { ok: true, skipped: true, reason: 'auto_dev_pr_columns_unavailable', error: String(err?.message || err) };
    }
  }

  if (name === 'analyze_tech_debt') {
    const targetPath = String(params.path || REPO_ROOT + '/bots');
    if (!existsSync(targetPath)) return { ok: false, error: `path not found: ${targetPath}` };

    const totalTs = countTsFiles(targetPath);
    const nocheckCount = countTsNocheck(targetPath);
    const largeFiles = getLargeFiles(targetPath, 500);
    const ratio = totalTs > 0 ? ((nocheckCount / totalTs) * 100).toFixed(1) : '0';

    return {
      ok: true,
      mode: 'tech_debt_analysis',
      path: targetPath,
      summary: {
        totalTsFiles: totalTs,
        tsNocheckCount: nocheckCount,
        tsNocheckRatio: `${ratio}%`,
        largeFilesCount: largeFiles.length,
      },
      largeFiles: largeFiles.slice(0, 10),
      priorities: [
        { rank: 1, area: '@ts-nocheck 복구', count: nocheckCount, strategy: '소형 파일부터, 팀별 점진적 제거' },
        { rank: 2, area: '대형 파일 분할', count: largeFiles.length, strategy: '단일 책임 기준 모듈 추출' },
      ],
    };
  }

  if (name === 'suggest_refactoring') {
    const filePath = String(params.file || '');
    if (!filePath || !existsSync(filePath)) return { ok: false, error: `file not found: ${filePath}` };

    const lineCount = getFileLineCount(filePath);
    const hasNocheck = hasTsNocheck(filePath);
    const funcCount = estimateFunctions(filePath);
    const fileName = path.basename(filePath);

    const suggestions = [];
    if (hasNocheck) {
      suggestions.push({
        type: 'type_recovery',
        priority: lineCount < 100 ? 'high' : 'medium',
        action: '@ts-nocheck 제거 → 타입 에러 수정 → strict 검증',
        estimatedEffort: lineCount < 100 ? '30분' : lineCount < 300 ? '1~2시간' : '반나절+',
      });
    }
    if (lineCount > 500) {
      suggestions.push({
        type: 'file_split',
        priority: 'high',
        action: `${Math.ceil(lineCount / 300)}개 모듈로 분할 제안 (책임별)`,
        estimatedEffort: lineCount > 2000 ? '1~2일' : '반나절',
      });
    }
    if (funcCount > 20) {
      suggestions.push({
        type: 'extract_utils',
        priority: 'low',
        action: '공통 유틸 함수 추출 → packages/core/lib/',
        estimatedEffort: '1~2시간',
      });
    }

    return {
      ok: true,
      mode: 'refactoring_suggestion',
      file: fileName,
      lineCount,
      hasNocheck,
      functionEstimate: funcCount,
      suggestions,
    };
  }

  if (name === 'split_large_file') {
    const filePath = String(params.file || '');
    const strategy = String(params.strategy || 'responsibility');
    if (!filePath || !existsSync(filePath)) return { ok: false, error: `file not found: ${filePath}` };

    const lineCount = getFileLineCount(filePath);
    const fileName = path.basename(filePath, '.ts');
    const dir = path.dirname(filePath);
    const moduleCount = Math.max(2, Math.ceil(lineCount / 400));

    return {
      ok: true,
      mode: 'split_plan',
      file: filePath,
      lineCount,
      strategy,
      plan: {
        targetModuleCount: moduleCount,
        targetLinesPerModule: Math.ceil(lineCount / moduleCount),
        suggestedOutputDir: `${dir}/${fileName}/`,
        steps: [
          `git tag refactor-${fileName}-$(date +%Y%m%d-%H%M) 먼저 생성`,
          `책임 분석: grep -n "export " "${filePath}" 로 공개 API 목록 확인`,
          `${moduleCount}개 책임 그룹으로 함수 분류`,
          `각 그룹을 ${dir}/${fileName}/*.ts 로 추출`,
          `원본 파일 → index.ts 재내보내기(re-export)로 변경`,
          '테스트 green 확인',
          'verify_refactoring 실행',
        ],
        safetyChecks: ['git tag 생성 확인', '테스트 기존 통과 확인', 'TypeScript 컴파일 에러 없음'],
      },
    };
  }

  if (name === 'restore_types') {
    const filePath = String(params.file || '');
    if (!filePath || !existsSync(filePath)) return { ok: false, error: `file not found: ${filePath}` };
    if (!hasTsNocheck(filePath)) return { ok: false, error: 'file does not have @ts-nocheck' };

    const lineCount = getFileLineCount(filePath);
    const fileName = path.basename(filePath);

    return {
      ok: true,
      mode: 'type_restore_plan',
      file: fileName,
      lineCount,
      steps: [
        `git tag type-restore-${path.basename(filePath, '.ts')}-$(date +%Y%m%d-%H%M)`,
        `// @ts-nocheck 첫 줄 제거`,
        `npx tsc --noEmit "${filePath}" 로 에러 확인`,
        `에러별: any → unknown 또는 명시 타입, import type 추가 등`,
        `tsc 에러 0 확인`,
        '테스트 통과 확인',
      ],
      estimatedEffort: lineCount < 50 ? '15분' : lineCount < 150 ? '30~60분' : '2시간+',
      risk: lineCount < 100 ? 'low' : lineCount < 500 ? 'medium' : 'high',
    };
  }

  if (name === 'verify_refactoring') {
    const beforePath = String(params.before || '');
    const afterPath = String(params.after || '');
    if (!afterPath || !existsSync(afterPath)) return { ok: false, error: `after file not found: ${afterPath}` };

    const afterLines = getFileLineCount(afterPath);
    const afterHasNocheck = hasTsNocheck(afterPath);
    const beforeLines = beforePath && existsSync(beforePath) ? getFileLineCount(beforePath) : null;

    const checks = {
      linesReduced: beforeLines !== null ? afterLines < beforeLines : null,
      nocheckRemoved: !afterHasNocheck,
    };

    return {
      ok: true,
      mode: 'static_verify',
      after: path.basename(afterPath),
      afterLines,
      beforeLines,
      afterHasNocheck,
      checks,
      pass: Object.values(checks).every((v) => v !== false),
      note: '3계층 검증의 Layer 1 (Static). LLM Judge / Monte Carlo는 plugin-eval.ts 참조.',
    };
  }

  return { ok: false, error: `unknown tool: ${name}` };
}

const PORT = Number(argValue('port', DEFAULT_PORT));
const HOST = String(argValue('host', process.env.CLAUDE_REFACTOR_MCP_HOST || '127.0.0.1'));
const IS_SMOKE = process.argv.includes('--smoke') || process.argv.includes('--json');
const IS_DIRECT_RUN = Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health') {
    return json(res, 200, { ok: true, service: 'claude-refactor-mcp', port: PORT });
  }

  if (url.pathname === '/tools' && req.method === 'GET') {
    return json(res, 200, { ok: true, tools: CLAUDE_REFACTOR_MCP_TOOLS });
  }

  const toolMatch = url.pathname.match(/^\/tools\/([^/]+)$/);
  if (toolMatch && req.method === 'POST') {
    const name = toolMatch[1];
    const params = await readBody(req).catch(() => ({}));
    const result = await handleTool(name, params);
    return json(res, result.ok ? 200 : 400, result);
  }

  json(res, 404, { ok: false, error: 'not found' });
});

if (IS_DIRECT_RUN && IS_SMOKE) {
  (async () => {
    const health = await hubFetch('/health');
    console.log(JSON.stringify({
      ok: true,
      service: 'claude-refactor-mcp',
      host: HOST,
      port: PORT,
      tools: CLAUDE_REFACTOR_MCP_TOOLS.map((t) => t.name),
      hubReachable: health.ok,
    }));
  })();
} else if (IS_DIRECT_RUN) {
  server.on('error', (err) => {
    console.error(`[claude-refactor-mcp] server error: ${err.message}`);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    console.log(`[claude-refactor-mcp] listening on http://${HOST}:${PORT}`);
  });
}
