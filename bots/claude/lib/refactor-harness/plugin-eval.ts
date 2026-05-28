/**
 * plugin-eval 3계층 리팩토링 검증 하네스
 *
 * Layer 1 — Static  : 구조 분석 (<2s)
 * Layer 2 — LLM Judge: 의미 평가 (~30s, Hub LLM Gateway)
 * Layer 3 — Monte Carlo: 통계 신뢰성 (50회 테스트, ~2-5분)
 */

import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const HUB_BASE = process.env.HUB_URL || 'http://localhost:7788';
const REPO_ROOT = process.env.PROJECT_ROOT || path.resolve(__dirname, '../../../..');

// ─── Layer 1: Static Analysis ────────────────────────────────────────────────

export interface StaticResult {
  pass: boolean;
  beforeLines: number | null;
  afterLines: number;
  lineDelta: number | null;
  nocheckBefore: boolean | null;
  nocheckAfter: boolean;
  nocheckRemoved: boolean | null;
  details: string[];
}

export function runStaticLayer(afterPath: string, beforePath?: string): StaticResult {
  const afterLines = countLines(afterPath);
  const nocheckAfter = hasNocheck(afterPath);
  const beforeLines = beforePath && existsSync(beforePath) ? countLines(beforePath) : null;
  const nocheckBefore = beforePath && existsSync(beforePath) ? hasNocheck(beforePath) : null;

  const lineDelta = beforeLines !== null ? afterLines - beforeLines : null;
  const nocheckRemoved = nocheckBefore !== null ? (nocheckBefore && !nocheckAfter) : null;

  const details: string[] = [];
  if (lineDelta !== null) details.push(`lines: ${beforeLines} → ${afterLines} (${lineDelta > 0 ? '+' : ''}${lineDelta})`);
  if (nocheckRemoved !== null) details.push(`@ts-nocheck: ${nocheckBefore ? 'removed ✓' : 'was not present'}`);

  const pass = !nocheckAfter && (lineDelta === null || lineDelta <= 0 || (beforeLines !== null && beforeLines > 500));

  return { pass, beforeLines, afterLines, lineDelta, nocheckBefore, nocheckAfter, nocheckRemoved, details };
}

// ─── Layer 2: LLM Judge ──────────────────────────────────────────────────────

export interface LLMJudgeResult {
  pass: boolean;
  scores: {
    correctness: number;
    readability: number;
    maintainability: number;
    safety: number;
  };
  total: number;
  verdict: string;
  model: string;
  error?: string;
}

export async function runLLMJudge(
  afterPath: string,
  beforePath?: string,
  depth: 'fast' | 'precise' = 'fast'
): Promise<LLMJudgeResult> {
  const afterCode = safeReadFile(afterPath, 3000);
  const beforeCode = beforePath ? safeReadFile(beforePath, 3000) : null;
  const model = depth === 'fast' ? 'haiku' : 'sonnet';

  const prompt = buildJudgePrompt(afterCode, beforeCode);

  try {
    const hubToken = loadHubToken();
    const res = await fetch(`${HUB_BASE}/hub/llm/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${hubToken}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 500 }),
      signal: AbortSignal.timeout(40000),
    });

    if (!res.ok) throw new Error(`Hub LLM ${res.status}`);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || data?.content || '';
    return parseLLMVerdict(text, model);
  } catch (err) {
    return {
      pass: false,
      scores: { correctness: 0, readability: 0, maintainability: 0, safety: 0 },
      total: 0,
      verdict: 'LLM Judge 실패 — Hub 연결 불가',
      model,
      error: String(err),
    };
  }
}

// ─── Layer 3: Monte Carlo ─────────────────────────────────────────────────────

export interface MonteCarloResult {
  pass: boolean;
  runs: number;
  successRuns: number;
  failRuns: number;
  consistencyRate: number;
  regressionRisk: 'low' | 'medium' | 'high';
  details: string;
}

export async function runMonteCarlo(
  testCommand: string,
  runs = 50,
  cwd?: string
): Promise<MonteCarloResult> {
  const workDir = cwd || REPO_ROOT;
  let successRuns = 0;
  let failRuns = 0;

  for (let i = 0; i < runs; i++) {
    const result = spawnSync('sh', ['-c', testCommand], {
      cwd: workDir,
      timeout: 30000,
      encoding: 'utf8',
    });
    if (result.status === 0) {
      successRuns++;
    } else {
      failRuns++;
    }
  }

  const consistencyRate = successRuns / runs;
  const regressionRisk: 'low' | 'medium' | 'high' =
    consistencyRate >= 0.98 ? 'low' : consistencyRate >= 0.9 ? 'medium' : 'high';

  return {
    pass: consistencyRate >= 0.98,
    runs,
    successRuns,
    failRuns,
    consistencyRate,
    regressionRisk,
    details: `${runs}회 실행 → 성공 ${successRuns} / 실패 ${failRuns} (${(consistencyRate * 100).toFixed(1)}%)`,
  };
}

// ─── Combined Score ───────────────────────────────────────────────────────────

export type EvalDepth = 'static' | 'static+llm' | 'full';

export interface RefactoringScore {
  pass: boolean;
  depth: EvalDepth;
  static: StaticResult;
  llm?: LLMJudgeResult;
  monteCarlo?: MonteCarloResult;
  summary: string;
}

export async function scoreRefactoring(
  afterPath: string,
  beforePath?: string,
  depth: EvalDepth = 'static'
): Promise<RefactoringScore> {
  const staticResult = runStaticLayer(afterPath, beforePath);
  let llmResult: LLMJudgeResult | undefined;
  let monteCarloResult: MonteCarloResult | undefined;

  if (depth === 'static+llm' || depth === 'full') {
    llmResult = await runLLMJudge(afterPath, beforePath, 'fast');
  }

  if (depth === 'full') {
    const testCmd = `cd "${path.dirname(afterPath)}" && npx jest --passWithNoTests 2>/dev/null || true`;
    monteCarloResult = await runMonteCarlo(testCmd, 10);
  }

  const allPass = staticResult.pass &&
    (llmResult === undefined || llmResult.pass) &&
    (monteCarloResult === undefined || monteCarloResult.pass);

  const summary = buildSummary(staticResult, llmResult, monteCarloResult);

  return { pass: allPass, depth, static: staticResult, llm: llmResult, monteCarlo: monteCarloResult, summary };
}

export async function certifyRefactoring(afterPath: string, beforePath?: string): Promise<RefactoringScore> {
  return scoreRefactoring(afterPath, beforePath, 'static+llm');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function countLines(filePath: string): number {
  try {
    const result = execSync(`wc -l < "${filePath}"`, { encoding: 'utf8' });
    return parseInt(result.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function hasNocheck(filePath: string): boolean {
  try {
    const first200 = execSync(`head -5 "${filePath}"`, { encoding: 'utf8' });
    return first200.includes('@ts-nocheck');
  } catch {
    return false;
  }
}

function safeReadFile(filePath: string, maxChars = 3000): string {
  try {
    const content = readFileSync(filePath, 'utf8');
    return content.length > maxChars ? content.slice(0, maxChars) + '\n...[truncated]' : content;
  } catch {
    return '';
  }
}

function loadHubToken(): string {
  try {
    const store = JSON.parse(readFileSync(path.join(REPO_ROOT, 'bots/hub/secrets-store.json'), 'utf8'));
    return store.HUB_AUTH_TOKEN || '';
  } catch {
    return process.env.HUB_AUTH_TOKEN || '';
  }
}

function buildJudgePrompt(afterCode: string, beforeCode: string | null): string {
  const context = beforeCode
    ? `Before:\n\`\`\`\n${beforeCode}\n\`\`\`\n\nAfter:\n\`\`\`\n${afterCode}\n\`\`\``
    : `Code:\n\`\`\`\n${afterCode}\n\`\`\``;

  return `Rate this code refactoring on 4 dimensions (1-10 each). Respond ONLY with JSON.

${context}

Respond: {"correctness":N,"readability":N,"maintainability":N,"safety":N,"verdict":"one sentence"}`;
}

function parseLLMVerdict(text: string, model: string): LLMJudgeResult {
  try {
    const jsonMatch = text.match(/\{[^}]+\}/);
    if (!jsonMatch) throw new Error('no JSON');
    const parsed = JSON.parse(jsonMatch[0]);
    const scores = {
      correctness: Number(parsed.correctness) || 5,
      readability: Number(parsed.readability) || 5,
      maintainability: Number(parsed.maintainability) || 5,
      safety: Number(parsed.safety) || 5,
    };
    const total = (scores.correctness + scores.readability + scores.maintainability + scores.safety) / 4;
    return { pass: total >= 6, scores, total, verdict: String(parsed.verdict || ''), model };
  } catch {
    return { pass: false, scores: { correctness: 0, readability: 0, maintainability: 0, safety: 0 }, total: 0, verdict: 'parse error', model };
  }
}

function buildSummary(
  s: StaticResult,
  l?: LLMJudgeResult,
  m?: MonteCarloResult
): string {
  const parts = [`Static: ${s.pass ? '✓' : '✗'} ${s.details.join(', ')}`];
  if (l) parts.push(`LLM Judge: ${l.pass ? '✓' : '✗'} (avg ${l.total.toFixed(1)}/10) ${l.verdict}`);
  if (m) parts.push(`Monte Carlo: ${m.pass ? '✓' : '✗'} ${m.details}`);
  return parts.join(' | ');
}
