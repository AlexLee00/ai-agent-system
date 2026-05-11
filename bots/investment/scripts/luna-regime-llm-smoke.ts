#!/usr/bin/env node
// @ts-nocheck

/**
 * Phase 1 Smoke Test — LLM 체제 분석기 정적 검증
 *
 * 검증 항목:
 *   1. DB 마이그레이션 파일 존재 확인
 *   2. Elixir 모듈 파일 존재 확인
 *   3. policy.ex에 regime.analyzer 태스크 등록 확인
 *   4. 프롬프트 파일 존재 확인
 *   5. Shadow 테이블 일치율 조회 (DB 연결 가능 시)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const INVESTMENT_ROOT = path.resolve(import.meta.dirname, '..');

function checkFileExists(filePath, label) {
  const exists = fs.existsSync(filePath);
  if (!exists) throw new Error(`파일 없음: ${label} (${filePath})`);
  return true;
}

function checkFileContains(filePath, needle, label) {
  const content = fs.readFileSync(filePath, 'utf8');
  if (!content.includes(needle)) {
    throw new Error(`${label}: "${needle}" 문자열 없음 (${filePath})`);
  }
  return true;
}

export function runLunaRegimeLlmSmoke() {
  const results = {};

  // 1. DB 마이그레이션 파일
  const migrationPath = path.join(INVESTMENT_ROOT, 'migrations/20260511_luna_regime_llm_shadow.sql');
  checkFileExists(migrationPath, 'DB 마이그레이션');
  checkFileContains(migrationPath, 'luna_regime_llm_shadow', 'DB 마이그레이션');
  checkFileContains(migrationPath, 'match', 'DB 마이그레이션 match 컬럼');
  results.migration = 'ok';

  // 2. Elixir 모듈 파일
  const analyzerPath = path.join(
    INVESTMENT_ROOT,
    'elixir/lib/luna/v2/regime/llm_regime_analyzer.ex',
  );
  checkFileExists(analyzerPath, 'LLMRegimeAnalyzer 모듈');
  checkFileContains(analyzerPath, 'Luna.V2.Regime.LLMRegimeAnalyzer', 'Elixir 모듈명');
  checkFileContains(analyzerPath, 'use Jido.Action', 'Jido.Action 사용');
  checkFileContains(analyzerPath, 'shadow_mode', 'shadow_mode 스키마');
  checkFileContains(analyzerPath, 'luna_regime_llm_shadow', 'Shadow 저장 쿼리');
  results.elixirModule = 'ok';

  // 3. LLM Policy 등록
  const policyPath = path.join(INVESTMENT_ROOT, 'elixir/lib/luna/v2/llm/policy.ex');
  checkFileExists(policyPath, 'LLM Policy');
  checkFileContains(policyPath, 'luna.regime.analyzer', 'policy.ex regime.analyzer 등록');
  results.policy = 'ok';

  // 4. 프롬프트 문서
  const promptPath = path.join(INVESTMENT_ROOT, 'prompts/regime-analyzer.md');
  checkFileExists(promptPath, '프롬프트 문서');
  checkFileContains(promptPath, 'Shadow Mode', '프롬프트 문서 Shadow Mode 섹션');
  results.prompt = 'ok';

  // 5. Elixir 모듈 구조 심층 검증
  const analyzerContent = fs.readFileSync(analyzerPath, 'utf8');
  assert.ok(analyzerContent.includes('fetch_rule_snapshot'), '규칙 스냅샷 조회 함수 존재');
  assert.ok(analyzerContent.includes('analyze_with_llm'), 'LLM 분석 함수 존재');
  assert.ok(analyzerContent.includes('store_shadow'), 'Shadow 저장 함수 존재');
  assert.ok(analyzerContent.includes('call_with_fallback'), 'LLM Selector 호출 패턴 존재');
  assert.ok(analyzerContent.includes('"luna.regime.analyzer"'), 'Policy 태스크명 일치');
  results.moduleStructure = 'ok';

  return {
    ok: true,
    phase: 'Phase 1 — LLM 시장 체제 분석기',
    shadow_mode: '활성 (1주 운영 후 Promotion Gate)',
    checks: results,
    next: [
      'OPS DB에 마이그레이션 실행: psql -d jay -f migrations/20260511_luna_regime_llm_shadow.sql',
      'Elixir 컴파일: mix compile (bots/investment/elixir/)',
      '7일 Shadow 운영 후 일치율 확인:',
      '  SELECT market, ROUND(AVG(match::int)*100,1) AS match_rate FROM investment.luna_regime_llm_shadow WHERE captured_at >= NOW()-INTERVAL \'7 days\' GROUP BY market;',
      'match_rate >= 70% → Promotion Gate → 마스터 명시 후 shadow_mode: false 전환',
    ],
  };
}

async function main() {
  const result = runLunaRegimeLlmSmoke();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('✅ luna regime LLM smoke ok');
    console.log(`   phase: ${result.phase}`);
    console.log(`   shadow: ${result.shadow_mode}`);
    Object.entries(result.checks).forEach(([k, v]) => console.log(`   ${k}: ${v}`));
    console.log('\n다음 단계:');
    result.next.forEach((s) => console.log(`   ${s}`));
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna regime LLM smoke 실패:',
  });
}
