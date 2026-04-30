#!/usr/bin/env node
// @ts-nocheck
/**
 * runtime-first-cycle-reflexion-verify.ts — Phase Z6+Z7: Reflexion 학습 누적 + 회피 검증 ⭐⭐⭐
 *
 * close → reflexion entry 누적 → 다음 사이클 회피 검증:
 *   reflexion_memory (luna_failure_reflexions) 1건 기록 확인
 *   rag_experience (mapek_knowledge) 1건 저장 확인
 *   다음 시그널 시점에 회피 동작 시뮬레이션
 *
 * 사용법:
 *   tsx bots/investment/scripts/runtime-first-cycle-reflexion-verify.ts
 *   tsx bots/investment/scripts/runtime-first-cycle-reflexion-verify.ts --json
 *   tsx bots/investment/scripts/runtime-first-cycle-reflexion-verify.ts --symbol=BTC/USDT
 */

import * as db from '../shared/db.ts';
import { checkAvoidPatterns } from '../shared/reflexion-engine.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: argv.includes('--json'),
    symbol: argv.find((a) => a.startsWith('--symbol='))?.split('=')[1] || null,
    market: argv.find((a) => a.startsWith('--market='))?.split('=')[1] || 'crypto',
    hours: Number(argv.find((a) => a.startsWith('--hours='))?.split('=')[1] || 168),
    dryRun: !argv.includes('--no-dry-run'),
  };
}

async function getReflexionEntries(symbol: string | null, hours: number) {
  try {
    const cond = symbol ? `AND (avoid_pattern::text ILIKE '%${symbol.split('/')[0]}%' OR avoid_pattern::text ILIKE '%${symbol}%')` : '';
    const rows = await db.query(
      `SELECT id, trade_id, five_why, stage_attribution, hindsight,
              avoid_pattern, created_at
         FROM investment.luna_failure_reflexions
        WHERE created_at >= NOW() - INTERVAL '${Math.max(1, hours)} hours'
          ${cond}
        ORDER BY created_at DESC
        LIMIT 20`,
      [],
    );
    return rows || [];
  } catch {
    return [];
  }
}

async function getReflexionCreatedEvents(symbol: string | null, hours: number) {
  try {
    const cond = symbol ? `AND payload::text ILIKE '%${symbol.split('/')[0]}%'` : '';
    const rows = await db.query(
      `SELECT id, event_type, payload, created_at
         FROM investment.mapek_knowledge
        WHERE event_type = 'reflexion_created'
          AND created_at >= NOW() - INTERVAL '${Math.max(1, hours)} hours'
          ${cond}
        ORDER BY created_at DESC
        LIMIT 10`,
      [],
    );
    return rows || [];
  } catch {
    return [];
  }
}

async function getRagExperiences(symbol: string | null, hours: number) {
  try {
    const symbolBase = symbol ? symbol.split('/')[0] : null;
    const cond = symbolBase ? `AND (metadata::text ILIKE '%${symbolBase}%' OR content ILIKE '%${symbolBase}%')` : '';
    const rows = await db.query(
      `SELECT id, collection, content, metadata, created_at
         FROM rag_documents
        WHERE collection IN ('rag_experience', 'luna_experience', 'investment_experience')
          AND (owner_agent = 'luna' OR metadata->>'team' = 'investment' OR metadata::text ILIKE '%luna%')
          AND created_at >= NOW() - INTERVAL '${Math.max(1, hours)} hours'
          ${cond}
        ORDER BY created_at DESC
        LIMIT 10`,
      [],
    ).catch(() => []);
    if ((rows || []).length > 0) return rows || [];
    const lunaRows = await db.query(
      `SELECT id, category AS collection, content, metadata, created_at
         FROM luna_rag_documents
        WHERE category IN ('rag_experience', 'luna_experience', 'investment_experience', 'trade_reflexion')
          AND (owner_agent = 'luna' OR metadata->>'team' = 'investment' OR metadata::text ILIKE '%luna%')
          AND created_at >= NOW() - INTERVAL '${Math.max(1, hours)} hours'
          ${cond}
        ORDER BY created_at DESC
        LIMIT 10`,
      [],
    ).catch(() => []);
    return lunaRows || [];
  } catch {
    return [];
  }
}

async function getReflexionBudgetStatus() {
  try {
    const row = await db.get(
      `SELECT COUNT(*)::int AS cnt
         FROM investment.mapek_knowledge
        WHERE event_type IN ('reflexion_created', 'reflexion_failed')
          AND created_at >= NOW()::date`,
      [],
    );
    return { todayCount: Number(row?.cnt || 0), estimatedCostUsd: Number(row?.cnt || 0) * 0.02 };
  } catch {
    return { todayCount: 0, estimatedCostUsd: 0 };
  }
}

async function getAllReflexionCount() {
  try {
    const row = await db.get(`SELECT COUNT(*)::int AS cnt FROM investment.luna_failure_reflexions`, []);
    return Number(row?.cnt || 0);
  } catch {
    return 0;
  }
}

async function simulateReflexionAvoidance(symbol: string, market: string, direction = 'long') {
  try {
    const result = await checkAvoidPatterns(symbol, market, direction);
    return {
      matched: result.matched,
      penalty: result.penalty,
      reason: result.reason,
      wouldBlock: result.matched && result.penalty >= 0.10,
    };
  } catch (err: any) {
    return { matched: false, penalty: 0, reason: `error: ${err?.message || err}`, wouldBlock: false };
  }
}

async function getNextSignalReflexionCheck(symbol: string, market: string) {
  try {
    const rows = await db.query(
      `SELECT id, trade_id, avoid_pattern, hindsight, created_at
         FROM investment.luna_failure_reflexions
        WHERE avoid_pattern->>'avoid_action' IN ('long_entry', 'LONG')
          AND (
            avoid_pattern->>'symbol_pattern' ILIKE '%${symbol.split('/')[0]}%'
            OR avoid_pattern->>'symbol_pattern' ILIKE '%${market}%'
          )
        ORDER BY created_at DESC
        LIMIT 5`,
      [],
    );
    return rows || [];
  } catch {
    return [];
  }
}

function checkDof(
  reflexionEntries: any[],
  reflexionEvents: any[],
  ragExperiences: any[],
  avoidanceResult: any,
  allCount: number,
) {
  const dof: string[] = [];

  dof.push(reflexionEntries.length > 0
    ? `✅ luna_failure_reflexions 기록 있음 (${reflexionEntries.length}건, 전체=${allCount}건)`
    : `⚠️  luna_failure_reflexions 없음 (rejected 거래 후 생성)`,
  );

  dof.push(reflexionEvents.length > 0
    ? `✅ mapek_knowledge reflexion_created 이벤트 (${reflexionEvents.length}건)`
    : `⚠️  reflexion_created 이벤트 없음`,
  );

  dof.push(ragExperiences.length > 0
    ? `✅ rag_experience 기록 있음 (${ragExperiences.length}건)`
    : `⚠️  rag_experience 없음 (rag_documents 컬렉션 확인 필요)`,
  );

  const hasOutcome = reflexionEntries.some((r) => {
    const pat = typeof r.avoid_pattern === 'string' ? JSON.parse(r.avoid_pattern) : (r.avoid_pattern || {});
    return pat.avoid_action && pat.reason;
  });
  dof.push(hasOutcome
    ? `✅ outcome 메타 정확 (avoid_action + reason 추출)`
    : reflexionEntries.length > 0
      ? `⚠️  avoid_pattern 불완전 — avoid_action/reason 확인 필요`
      : `⚠️  outcome 메타 확인 불가 (기록 없음)`,
  );

  const hasFiveWhy = reflexionEntries.some((r) => {
    const fw = r.five_why;
    return Array.isArray(fw) ? fw.length > 0 : !!fw;
  });
  dof.push(hasFiveWhy
    ? `✅ 5-Why 자동 추출 완료`
    : reflexionEntries.length > 0
      ? `⚠️  5-Why 없음 — LLM 호출 실패 가능`
      : `⚠️  5-Why 확인 불가`,
  );

  dof.push(avoidanceResult.matched
    ? `✅ Reflexion 회피 매칭! penalty=${avoidanceResult.penalty} (다음 진입 시 차단됨)`
    : `ℹ️  현재 Reflexion 회피 없음 (기록 없거나 패턴 불일치)`,
  );

  return dof;
}

export async function runFirstCycleReflexionVerify({
  symbol = null,
  market = 'crypto',
  hours = 168,
  dryRun = true,
}: { symbol?: string | null; market?: string; hours?: number; dryRun?: boolean } = {}) {
  await db.initSchema();

  const testSymbol = symbol || 'BTC/USDT';
  const testMarket = market || 'crypto';

  const [
    reflexionEntries,
    reflexionEvents,
    ragExperiences,
    budgetStatus,
    allCount,
    nextSignalCheck,
  ] = await Promise.allSettled([
    getReflexionEntries(symbol, hours),
    getReflexionCreatedEvents(symbol, hours),
    getRagExperiences(symbol, hours),
    getReflexionBudgetStatus(),
    getAllReflexionCount(),
    getNextSignalReflexionCheck(testSymbol, testMarket),
  ]).then((results) => results.map((r) => (r.status === 'fulfilled' ? r.value : null)));

  const avoidanceResult = await simulateReflexionAvoidance(testSymbol, testMarket, 'long');

  const dof = checkDof(
    reflexionEntries || [],
    reflexionEvents || [],
    ragExperiences || [],
    avoidanceResult,
    allCount || 0,
  );

  const latestEntry = (reflexionEntries || [])[0] || null;
  const latestPat = latestEntry
    ? (typeof latestEntry.avoid_pattern === 'string'
        ? JSON.parse(latestEntry.avoid_pattern)
        : (latestEntry.avoid_pattern || {}))
    : null;
  const latestFiveWhy = latestEntry
    ? (typeof latestEntry.five_why === 'string' ? JSON.parse(latestEntry.five_why) : latestEntry.five_why)
    : null;

  return {
    ok: (allCount || 0) > 0,
    checkedAt: new Date().toISOString(),
    symbol: testSymbol,
    market: testMarket,
    dryRun,
    dof,
    summary: {
      totalReflexionEntries: allCount || 0,
      recentEntries: (reflexionEntries || []).length,
      reflexionCreatedEvents: (reflexionEvents || []).length,
      ragExperienceCount: (ragExperiences || []).length,
    },
    latestEntry: latestEntry ? {
      id: latestEntry.id,
      tradeId: latestEntry.trade_id,
      hindsight: latestEntry.hindsight,
      avoidPattern: latestPat,
      fiveWhyCount: Array.isArray(latestFiveWhy) ? latestFiveWhy.length : (latestFiveWhy ? 1 : 0),
      createdAt: latestEntry.created_at,
    } : null,
    avoidanceSimulation: {
      testSymbol,
      testMarket,
      direction: 'long',
      matched: avoidanceResult.matched,
      penalty: avoidanceResult.penalty,
      reason: avoidanceResult.reason,
      wouldBlock: avoidanceResult.wouldBlock,
      nextSignalBlockPatterns: (nextSignalCheck || []).length,
    },
    recentEntries: (reflexionEntries || []).slice(0, 5).map((r) => {
      const pat = typeof r.avoid_pattern === 'string' ? JSON.parse(r.avoid_pattern) : (r.avoid_pattern || {});
      const fw = typeof r.five_why === 'string' ? JSON.parse(r.five_why) : (r.five_why || []);
      return {
        id: r.id,
        tradeId: r.trade_id,
        avoidPattern: pat,
        fiveWhyCount: Array.isArray(fw) ? fw.length : 0,
        hindsightPreview: String(r.hindsight || '').slice(0, 100),
        createdAt: r.created_at,
      };
    }),
    ragExperiences: (ragExperiences || []).slice(0, 5).map((r) => ({
      id: r.id,
      collection: r.collection,
      contentPreview: String(r.content || '').slice(0, 80),
      createdAt: r.created_at,
    })),
    budget: budgetStatus || { todayCount: 0, estimatedCostUsd: 0 },
  };
}

async function main() {
  const args = parseArgs();
  const result = await runFirstCycleReflexionVerify({
    symbol: args.symbol,
    market: args.market,
    hours: args.hours,
    dryRun: args.dryRun,
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('');
  console.log('🧠 Phase Z6+Z7: Reflexion 학습 + 회피 검증 ⭐⭐⭐');
  console.log('='.repeat(50));
  console.log(`checkedAt: ${result.checkedAt}`);
  console.log(`testSymbol: ${result.symbol} / market: ${result.market}`);
  console.log('');

  const s = result.summary;
  console.log('📊 Reflexion 전체 현황');
  console.log(`  luna_failure_reflexions 전체: ${s.totalReflexionEntries}건`);
  console.log(`  최근 ${args.hours}h 신규: ${s.recentEntries}건`);
  console.log(`  reflexion_created 이벤트: ${s.reflexionCreatedEvents}건`);
  console.log(`  rag_experience: ${s.ragExperienceCount}건`);
  console.log('');

  if (result.latestEntry) {
    const e = result.latestEntry;
    console.log('📝 최신 Reflexion Entry');
    console.log(`  id: ${e.id} / trade_id: ${e.tradeId}`);
    console.log(`  avoidAction: ${e.avoidPattern?.avoid_action || 'n/a'}`);
    console.log(`  symbolPattern: ${e.avoidPattern?.symbol_pattern || 'n/a'}`);
    console.log(`  reason: ${String(e.avoidPattern?.reason || 'n/a').slice(0, 80)}`);
    console.log(`  5-Why: ${e.fiveWhyCount}개`);
    console.log(`  hindsight: ${String(e.hindsight || '').slice(0, 80)}`);
    console.log(`  createdAt: ${e.createdAt}`);
    console.log('');
  }

  if (result.recentEntries.length > 0) {
    console.log('📋 최근 Reflexion 목록');
    for (const e of result.recentEntries) {
      const pat = e.avoidPattern;
      console.log(`  trade#${e.tradeId} [${pat?.avoid_action || 'n/a'}] ${pat?.symbol_pattern || 'n/a'} — ${e.hindsightPreview}`);
    }
    console.log('');
  }

  const sim = result.avoidanceSimulation;
  console.log('🛡️  다음 사이클 회피 시뮬레이션');
  console.log(`  symbol: ${sim.testSymbol} / direction: ${sim.direction}`);
  console.log(`  matched: ${sim.matched ? '✅ 매칭!' : '❌ 매칭 없음'}`);
  if (sim.matched) {
    console.log(`  penalty: ${sim.penalty} (confidence ${sim.penalty * 100}% 차감)`);
    console.log(`  wouldBlock: ${sim.wouldBlock ? '✅ 진입 차단됨' : '⚠️  차단 아님 (penalty만 적용)'}`);
    console.log(`  reason: ${sim.reason}`);
  } else {
    console.log(`  → 현재 패턴 없음 (SELL 후 rejected 거래가 있어야 Reflexion 생성)`);
  }
  console.log('');

  if (result.ragExperiences.length > 0) {
    console.log('🗃️  RAG Experience');
    for (const r of result.ragExperiences) {
      console.log(`  [${r.collection}] ${r.contentPreview}`);
    }
    console.log('');
  }

  console.log('💰 오늘 Reflexion LLM 예산');
  console.log(`  호출: ${result.budget.todayCount}건 (~$${result.budget.estimatedCostUsd.toFixed(3)})`);
  console.log('');

  console.log('✅ Definition of Done (Z6+Z7)');
  for (const line of result.dof) {
    console.log(`  ${line}`);
  }
  console.log('');

  if (sim.wouldBlock) {
    console.log('🎯 마스터 비전 "능동 대응 (Reflexion)" ⭐⭐⭐');
    console.log('   → 다음 동일 패턴 시그널 시점에 Reflexion 회피 활성!');
    console.log('   → "결과가 학습으로 이어짐" 실측 완료!');
  } else {
    console.log('ℹ️  Reflexion 사이클 완성을 위해:');
    console.log('   1. SELL 실행 → trade 기록 완료');
    console.log('   2. trade_quality overall_score ≤ 0.4 (rejected) 시 자동 Reflexion');
    console.log('   3. 또는 posttrade-feedback-worker 실행 후 mapek_knowledge 확인');
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-first-cycle-reflexion-verify 실패:',
  });
}
