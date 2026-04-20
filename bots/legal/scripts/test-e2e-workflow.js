#!/usr/bin/env node
'use strict';

/**
 * test-e2e-workflow.js — 저스틴팀 E2E 워크플로우 통합 테스트
 *
 * 실행: node scripts/test-e2e-workflow.js [--full] [--cleanup]
 *
 * --full     전체 워크플로우 (브리핑+클레임/디펜스+판례+감정서)
 * --cleanup  테스트 종료 후 테스트 사건 DB 삭제
 */

const path = require('path');
const env = require('../../../packages/core/lib/env');

const TEST_CASE_NUMBER = 'E2E-TEST-2026-001';
let testCaseId = null;

function pass(msg) { console.log(`  ✅ ${msg}`); }
function fail(msg) { console.error(`  ❌ ${msg}`); process.exitCode = 1; }
function section(msg) { console.log(`\n─── ${msg} ───`); }

async function cleanup(store) {
  try {
    const c = await store.getCaseByCaseNumber(TEST_CASE_NUMBER);
    if (c) {
      const pool = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/pg-pool'));
      await pool.query('legal', 'DELETE FROM cases WHERE id = $1', [c.id]);
      console.log(`  🗑️  테스트 사건 삭제 완료 (id=${c.id})`);
    }
  } catch (err) {
    console.warn(`  ⚠️  cleanup 실패: ${err.message}`);
  }
}

async function testDbConnectivity(store) {
  section('DB 연결 테스트');
  try {
    const cases = await store.listCases();
    pass(`DB 연결 성공 (현재 사건 수: ${cases.length})`);
    return true;
  } catch (err) {
    fail(`DB 연결 실패: ${err.message}`);
    console.error('  → psql -U jay -d jay -f bots/legal/migrations/001-appraisal-schema.sql 실행 필요');
    return false;
  }
}

async function testCaseIntake(store, justin, router) {
  section('감정 촉탁 접수 (사건 DB 등록)');
  try {
    // 기존 테스트 사건 있으면 삭제
    const existing = await store.getCaseByCaseNumber(TEST_CASE_NUMBER);
    if (existing) {
      const pool = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/pg-pool'));
      await pool.query('legal', 'DELETE FROM cases WHERE id = $1', [existing.id]);
    }

    // 사건 유형 분류 (키워드 기반)
    const routerResult = router.inferTypeFromKeywords('소스코드 유사도 저작권 침해 GUI 화면구성');
    pass(`키워드 분류: ${routerResult || '(LLM 분류 필요)'}`);

    // 사건 생성
    const caseRecord = await store.createCase({
      case_number: TEST_CASE_NUMBER,
      court: 'E2E 테스트 법원',
      case_type: 'copyright',
      plaintiff: '원고 주식회사 테스트',
      defendant: '피고 주식회사 테스트',
      appraisal_items: ['소스코드 유사도 분석', '기능 동일성 여부 확인'],
      deadline: null,
      notes: '[자동 E2E 테스트 — 삭제 가능]',
    });
    testCaseId = caseRecord.id;
    pass(`사건 등록 성공: id=${caseRecord.id}, type=${caseRecord.case_type}`);
    return caseRecord;
  } catch (err) {
    fail(`사건 접수 실패: ${err.message}`);
    return null;
  }
}

async function testModuleLoads() {
  section('에이전트 모듈 로드 테스트');
  const agents = ['justin', 'briefing', 'lens', 'garam', 'atlas', 'claim', 'defense', 'quill', 'balance', 'contro', 'similarity-engine', 'appraisal-store', 'case-router', 'llm-helper'];
  let allPassed = true;
  for (const agent of agents) {
    try {
      require(path.join(env.PROJECT_ROOT, `bots/legal/lib/${agent}`));
      pass(`${agent} 로드 OK`);
    } catch (err) {
      fail(`${agent} 로드 실패: ${err.message}`);
      allPassed = false;
    }
  }
  return allPassed;
}

async function testBriefingPhase(store, briefing, caseRecord) {
  section('Phase 2: 브리핑 (사건 분석 + 착수계획서)');
  const caseData = {
    ...caseRecord,
    classification: { case_type: caseRecord.case_type },
  };
  try {
    console.log('  📝 감정착수계획서 작성 중... (LLM 호출, 30~90초 소요)');
    const result = await briefing.writeInceptionPlan(caseRecord.id, caseData);
    if (result && result.content) {
      pass(`착수계획서 생성 성공 (${result.content.length}바이트, provider: ${result.provider || 'unknown'})`);
      const report = await store.getLatestReport(caseRecord.id, 'inception_plan');
      if (report) pass(`DB 저장 확인: version=${report.version}, status=${report.review_status}`);
      else fail('DB 저장 실패 (report not found)');
      return result;
    } else {
      fail('착수계획서 응답 없음 또는 content 비어 있음');
      return null;
    }
  } catch (err) {
    fail(`착수계획서 작성 실패: ${err.message}`);
    return null;
  }
}

async function testCaseRouterFull(router) {
  section('케이스 라우터 전체 검증');
  const types = ['copyright', 'defect', 'contract', 'trade_secret', 'other'];
  for (const type of types) {
    const route = router.getAgentRoute(type);
    if (route && route.required.includes('balance')) {
      pass(`${type}: ${route.required.join(', ')}`);
    } else {
      fail(`${type}: balance 미포함 또는 라우트 없음`);
    }
  }
}

async function testSimilarityEngine(engine) {
  section('유사도 엔진 검증');
  const codeA = `
function calculateTotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}
function applyDiscount(total, rate) {
  return total * (1 - rate);
}`;
  const codeB = `
function computeSum(itemList) {
  return itemList.reduce((acc, el) => acc + el.price * el.quantity, 0);
}
function calcDiscount(total, discountRate) {
  return total * (1 - discountRate);
}`;

  try {
    const result = engine.analyzeCodeSimilarity(codeA, codeB);
    pass(`유사도 분석 완료 — composite: ${result.composite_score.toFixed(1)}%, risk: ${result.copy_risk}`);
    pass(`line: ${result.line_similarity.score}%, token: ${result.token_similarity.score}%, structure: ${result.structure_similarity.score}%`);
  } catch (err) {
    fail(`유사도 엔진 오류: ${err.message}`);
  }
}

async function testGenerateReport(store, caseRecord) {
  section('generate-report.js 출력 검증');
  const report = await store.getLatestReport(caseRecord.id, 'inception_plan');
  if (!report) {
    console.log('  ⏭️  착수계획서 없음 — generate-report 테스트 건너뜀');
    return;
  }

  const fs = require('fs');
  const safeName = TEST_CASE_NUMBER.replace(/[\s\/\\:*?"<>|]/g, '_');
  const outputDir = path.join(env.PROJECT_ROOT, 'bots/legal/cases', safeName, 'report');
  const outputPath = path.join(outputDir, `감정착수계획서_v${report.version}.md`);

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const header = `<!-- E2E 테스트 생성 — 삭제 가능 -->\n\n`;
  fs.writeFileSync(outputPath, header + (report.content_md || ''), 'utf8');

  const stat = fs.statSync(outputPath);
  pass(`감정서 파일 생성: ${outputPath} (${stat.size}바이트)`);
}

async function main() {
  const args = process.argv.slice(2);
  const fullMode = args.includes('--full');
  const doCleanup = args.includes('--cleanup');

  console.log('\n🧪 저스틴팀 E2E 워크플로우 통합 테스트');
  console.log(`   모드: ${fullMode ? 'FULL' : 'QUICK'} | cleanup: ${doCleanup}`);
  console.log(`   시작: ${new Date().toLocaleString('ko-KR')}\n`);

  // 모듈 로드
  const store = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/appraisal-store'));
  const briefing = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/briefing'));
  const engine = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/similarity-engine'));
  const router = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/case-router'));
  const justin = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/justin'));

  // 1. 모듈 로드 테스트
  const modulesOk = await testModuleLoads();
  if (!modulesOk) {
    console.error('\n❌ 모듈 로드 실패 — 테스트 중단');
    process.exit(1);
  }

  // 2. DB 연결
  const dbOk = await testDbConnectivity(store);
  if (!dbOk) {
    console.error('\n❌ DB 연결 실패 — 테스트 중단');
    process.exit(1);
  }

  // 3. 케이스 라우터
  await testCaseRouterFull(router);

  // 4. 유사도 엔진
  await testSimilarityEngine(engine);

  // 5. 사건 접수
  const caseRecord = await testCaseIntake(store, justin, router);
  if (!caseRecord) {
    console.error('\n❌ 사건 접수 실패 — 테스트 중단');
    process.exit(1);
  }

  // 6. 브리핑 (LLM 호출)
  const briefingResult = await testBriefingPhase(store, briefing, caseRecord);

  // 7. generate-report 검증
  if (briefingResult) {
    await testGenerateReport(store, caseRecord);
  }

  // Full 모드: 추가 단계
  if (fullMode && briefingResult) {
    section('Phase 2.5: 클레임+디펜스 병렬 분석 (FULL 모드)');
    console.log('  📌 Full 모드: 클레임/디펜스는 실제 소스코드 필요 — 구조 검증만 수행');
    const claim = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/claim'));
    const defense = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/defense'));
    if (typeof claim.analyzePlaintiff === 'function') pass('claim.analyzePlaintiff 함수 존재');
    else fail('claim.analyzePlaintiff 미구현');
    if (typeof defense.analyzeDefendant === 'function') pass('defense.analyzeDefendant 함수 존재');
    else fail('defense.analyzeDefendant 미구현');

    section('Phase 3: 판례 분석 API 구조 검증 (FULL 모드)');
    const garam = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/garam'));
    const atlas = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/atlas'));
    if (typeof garam.searchDomesticCases === 'function') pass('garam.searchDomesticCases 함수 존재');
    else fail('garam.searchDomesticCases 미구현');
    if (typeof atlas.searchForeignCases === 'function') pass('atlas.searchForeignCases 함수 존재');
    else fail('atlas.searchForeignCases 미구현');
  }

  // Cleanup
  if (doCleanup) {
    section('테스트 정리');
    await cleanup(store);
  } else {
    console.log(`\n  ℹ️  테스트 사건 유지 중 (id=${testCaseId})`);
    console.log(`     삭제: node scripts/test-e2e-workflow.js --cleanup`);
  }

  const exitCode = process.exitCode || 0;
  console.log(`\n${exitCode === 0 ? '✅ 모든 테스트 통과' : '❌ 일부 테스트 실패'}`);
  console.log(`완료: ${new Date().toLocaleString('ko-KR')}\n`);
  process.exit(exitCode);
}

main().catch(err => {
  console.error('\n[E2E] 치명적 오류:', err.message);
  console.error(err.stack);
  process.exit(1);
});
