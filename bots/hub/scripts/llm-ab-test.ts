// @ts-nocheck
'use strict';

// LLM A/B 테스트 도구
// 동일 프롬프트를 두 모델에 보내 품질·비용·레이턴시를 비교
//
// 사용법:
//   tsx bots/hub/scripts/llm-ab-test.ts --prompt "분석해줘" --modelA anthropic_haiku --modelB anthropic_sonnet
//   tsx bots/hub/scripts/llm-ab-test.ts --file prompts.json  (배치)
//   tsx bots/hub/scripts/llm-ab-test.ts --auto-router-compare  (Auto-Router vs 현재 매핑 비교)

import path from 'node:path';
import fs from 'node:fs';
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const hubClient = require(path.join(PROJECT_ROOT, 'packages/core/lib/hub-client'));

const VALID_MODELS = ['anthropic_haiku', 'anthropic_sonnet', 'anthropic_opus'];

interface ABTestCase {
  prompt: string;
  systemPrompt?: string;
  taskType?: string;
  agent?: string;
}

interface ABTestResult {
  prompt_preview: string;
  modelA: string;
  modelB: string;
  latencyA_ms: number;
  latencyB_ms: number;
  costA_usd: number;
  costB_usd: number;
  successA: boolean;
  successB: boolean;
  judgeScore: { a: number; b: number; winner: 'A' | 'B' | 'tie' } | null;
  responseA_preview: string;
  responseB_preview: string;
}

// ─── LLM 호출 ────────────────────────────────────────────────────────────────

async function callModel(tc: ABTestCase, abstractModel: string): Promise<{
  text: string;
  latencyMs: number;
  costUsd: number;
  success: boolean;
  error?: string;
}> {
  const start = Date.now();
  try {
    const resp = await hubClient.callHubLlm({
      prompt: tc.prompt,
      systemPrompt: tc.systemPrompt,
      abstractModel,
      taskType: tc.taskType,
      agent: tc.agent || 'llm-ab-test',
      callerTeam: 'hub',
    });
    const latencyMs = Date.now() - start;
    return {
      text: resp.text || resp.content || '',
      latencyMs,
      costUsd: resp.cost_usd || resp.costUsd || 0,
      success: Boolean(resp.text || resp.content),
    };
  } catch (e: any) {
    return {
      text: '',
      latencyMs: Date.now() - start,
      costUsd: 0,
      success: false,
      error: e?.message,
    };
  }
}

// ─── LLM-as-Judge 품질 평가 ───────────────────────────────────────────────────

async function judgeResponses(prompt: string, responseA: string, responseB: string): Promise<{
  a: number; b: number; winner: 'A' | 'B' | 'tie';
} | null> {
  if (!responseA || !responseB) return null;

  const judgePrompt = `다음 두 AI 응답 중 어느 것이 더 좋은지 평가해줘.

질문: ${prompt.slice(0, 500)}

응답 A:
${responseA.slice(0, 800)}

응답 B:
${responseB.slice(0, 800)}

JSON 형식으로만 답해줘:
{"a": <0-10>, "b": <0-10>, "reason": "<한 줄>"}
`;

  try {
    const resp = await hubClient.callHubLlm({
      prompt: judgePrompt,
      abstractModel: 'anthropic_haiku',
      agent: 'llm-ab-judge',
      callerTeam: 'hub',
    });
    const text = (resp.text || resp.content || '').trim();
    const match = text.match(/\{[^}]+\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    const a = Number(parsed.a) || 5;
    const b = Number(parsed.b) || 5;
    const winner = a > b ? 'A' : b > a ? 'B' : 'tie';
    return { a, b, winner };
  } catch {
    return null;
  }
}

// ─── 단건 A/B 테스트 ─────────────────────────────────────────────────────────

async function runAbTest(tc: ABTestCase, modelA: string, modelB: string): Promise<ABTestResult> {
  console.log(`[A/B] 테스트 시작: ${modelA} vs ${modelB}`);

  const [rA, rB] = await Promise.allSettled([
    callModel(tc, modelA),
    callModel(tc, modelB),
  ]);

  const resultA = rA.status === 'fulfilled' ? rA.value : { text: '', latencyMs: 0, costUsd: 0, success: false };
  const resultB = rB.status === 'fulfilled' ? rB.value : { text: '', latencyMs: 0, costUsd: 0, success: false };

  const judgeScore = await judgeResponses(tc.prompt, resultA.text, resultB.text);

  return {
    prompt_preview: tc.prompt.slice(0, 100),
    modelA,
    modelB,
    latencyA_ms: resultA.latencyMs,
    latencyB_ms: resultB.latencyMs,
    costA_usd: resultA.costUsd,
    costB_usd: resultB.costUsd,
    successA: resultA.success,
    successB: resultB.success,
    judgeScore,
    responseA_preview: resultA.text.slice(0, 200),
    responseB_preview: resultB.text.slice(0, 200),
  };
}

// ─── Auto-Router 비교 모드 ────────────────────────────────────────────────────

async function runAutoRouterCompare(testCases: ABTestCase[]): Promise<void> {
  const { routeModel } = require('../lib/llm/llm-auto-router');

  console.log(`\n[Auto-Router Compare] ${testCases.length}개 케이스 테스트\n`);

  const results: Array<{
    prompt: string;
    autoModel: string;
    complexity: string;
    manualModel: string;
    winner: string;
  }> = [];

  for (const tc of testCases) {
    const autoResult = routeModel({ ...tc, abstractModel: undefined });
    const manualModel = tc['manualModel'] || 'anthropic_sonnet';

    if (autoResult.resolvedModel === manualModel) {
      results.push({
        prompt: tc.prompt.slice(0, 60),
        autoModel: autoResult.resolvedModel,
        complexity: autoResult.complexity,
        manualModel,
        winner: 'same',
      });
      continue;
    }

    const abResult = await runAbTest(tc, autoResult.resolvedModel, manualModel);
    results.push({
      prompt: tc.prompt.slice(0, 60),
      autoModel: autoResult.resolvedModel,
      complexity: autoResult.complexity,
      manualModel,
      winner: abResult.judgeScore?.winner === 'A' ? 'auto'
        : abResult.judgeScore?.winner === 'B' ? 'manual'
        : 'tie',
    });
  }

  printSummary(results);
}

// ─── 결과 출력 ────────────────────────────────────────────────────────────────

function printResult(result: ABTestResult): void {
  console.log('\n' + '='.repeat(60));
  console.log(`프롬프트: ${result.prompt_preview}...`);
  console.log(`${result.modelA}: ${result.latencyA_ms}ms / $${result.costA_usd.toFixed(6)} / ${result.successA ? '✓' : '✗'}`);
  console.log(`${result.modelB}: ${result.latencyB_ms}ms / $${result.costB_usd.toFixed(6)} / ${result.successB ? '✓' : '✗'}`);
  if (result.judgeScore) {
    console.log(`Judge: A=${result.judgeScore.a}/10  B=${result.judgeScore.b}/10  Winner=${result.judgeScore.winner}`);
  }
  const costSave = result.costB_usd - result.costA_usd;
  if (costSave > 0) console.log(`A 선택 시 비용 절감: $${costSave.toFixed(6)}`);
}

function printSummary(results: Array<{ winner: string }>): void {
  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.winner] = (acc[r.winner] || 0) + 1;
    return acc;
  }, {});
  console.log('\n[요약]', JSON.stringify(counts, null, 2));
}

// ─── CLI 엔트리포인트 ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  if (args.includes('--auto-router-compare')) {
    const file = get('--file');
    const testCases: ABTestCase[] = file
      ? JSON.parse(fs.readFileSync(file, 'utf8'))
      : [
          { prompt: '2+2는?', taskType: 'factual' },
          { prompt: '파이썬으로 퀵소트 알고리즘을 구현해줘', taskType: 'generation' },
          { prompt: '이 코드의 시간복잡도를 분석하고 최적화 방법을 제안해줘: function fib(n){ return n<=1?n:fib(n-1)+fib(n-2); }', taskType: 'analysis' },
        ];
    await runAutoRouterCompare(testCases);
    return;
  }

  const prompt = get('--prompt');
  const modelA = get('--modelA') || 'anthropic_haiku';
  const modelB = get('--modelB') || 'anthropic_sonnet';
  const file = get('--file');

  if (!VALID_MODELS.includes(modelA) || !VALID_MODELS.includes(modelB)) {
    console.error(`유효한 모델: ${VALID_MODELS.join(', ')}`);
    process.exit(1);
  }

  if (file) {
    const cases: ABTestCase[] = JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log(`[배치] ${cases.length}개 케이스 처리`);
    const allResults: ABTestResult[] = [];
    for (const tc of cases) {
      const r = await runAbTest(tc, modelA, modelB);
      printResult(r);
      allResults.push(r);
    }
    const outPath = path.join(PROJECT_ROOT, `bots/hub/output/llm-ab-test-${Date.now()}.json`);
    fs.writeFileSync(outPath, JSON.stringify(allResults, null, 2));
    console.log(`\n결과 저장: ${outPath}`);
    return;
  }

  if (!prompt) {
    console.error('--prompt 또는 --file 이 필요합니다');
    console.error('사용법: tsx llm-ab-test.ts --prompt "..." --modelA anthropic_haiku --modelB anthropic_sonnet');
    process.exit(1);
  }

  const result = await runAbTest({ prompt }, modelA, modelB);
  printResult(result);
}

main().catch((e) => {
  console.error('[AB Test] 오류:', e?.message || e);
  process.exit(1);
});
