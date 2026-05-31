#!/usr/bin/env node
// @ts-nocheck
/**
 * scripts/luna-dsr-gap-analysis.ts — DSR↔기존 갭 분석 (read-only)
 *
 * candidate_backtest_status의 신규 dsr/psr/sr0(Phase 1b shadow)과
 * 기존 healthy/sharpe_oos_deflated를 비교. DB 쓰기 없음 — SELECT only.
 *
 * 실행: npx tsx scripts/luna-dsr-gap-analysis.ts [--threshold=0.95]
 */

import { createRequire } from 'module';
import * as fs from 'fs';
import * as path from 'path';
import * as db from '../shared/db.ts';

const _require = createRequire(import.meta.url);
const kst = _require('../../../packages/core/lib/kst');

const args = process.argv.slice(2);
const threshArg = args.find((a) => a.startsWith('--threshold='));
const DSR_THRESHOLD = threshArg ? parseFloat(threshArg.split('=')[1]) : 0.95;
const TODAY: string = kst.today();

// ── 유틸 ──────────────────────────────────────────────────────────────

function safeNum(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseJsonArray(v: any): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function medianOf(arr: number[]): number | null {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/** 동순위는 평균 순위(1-based). null 요소는 null rank 반환. */
function rankArray(arr: (number | null)[]): (number | null)[] {
  const indexed = arr
    .map((v, i) => ({ v, i }))
    .filter((x) => x.v !== null) as { v: number; i: number }[];
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array(arr.length).fill(null);
  let j = 0;
  while (j < indexed.length) {
    let k = j;
    while (k < indexed.length - 1 && indexed[k + 1].v === indexed[j].v) k++;
    const avgRank = (j + k) / 2 + 1;
    for (let m = j; m <= k; m++) ranks[indexed[m].i] = avgRank;
    j = k + 1;
  }
  return ranks;
}

function pearsonCorr(x: number[], y: number[]): number | null {
  if (x.length < 3) return null;
  const n = x.length;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom < 1e-10 ? null : num / denom;
}

function spearmanRho(xs: (number | null)[], ys: (number | null)[]): { rho: number | null; n: number } {
  const rx = rankArray(xs);
  const ry = rankArray(ys);
  const px: number[] = [], py: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    if (rx[i] !== null && ry[i] !== null) {
      px.push(rx[i] as number);
      py.push(ry[i] as number);
    }
  }
  return { rho: pearsonCorr(px, py), n: px.length };
}

function statSummary(vals: number[]) {
  const finite = vals.filter(Number.isFinite);
  return {
    count: finite.length,
    min: finite.length ? Math.min(...finite) : null,
    median: medianOf(finite),
    max: finite.length ? Math.max(...finite) : null,
  };
}

function fmt(n: number | null, digits = 3): string {
  return n === null ? 'N/A' : n.toFixed(digits);
}

// ── 분석 함수 ─────────────────────────────────────────────────────────

function flipMatrix(rows: any[], threshold: number) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const r of rows) {
    const h = Boolean(r.healthy);
    const d = safeNum(r.dsr);
    if (d === null) continue;
    const dPass = d >= threshold;
    if (h && dPass)  tp++;
    else if (h && !dPass) fp++;
    else if (!h && dPass) fn++;
    else tn++;
  }
  return { tp, fp, fn, tn, total: tp + fp + fn + tn, threshold };
}

function rankCorrelation(rows: any[]) {
  const xs = rows.map((r) => safeNum(r.sharpe_oos_deflated));
  const ys = rows.map((r) => safeNum(r.dsr));
  return spearmanRho(xs, ys);
}

function unitSanity(rows: any[]) {
  const dsrVals  = rows.map((r) => safeNum(r.dsr)).filter((v) => v !== null) as number[];
  const psrVals  = rows.map((r) => safeNum(r.psr)).filter((v) => v !== null) as number[];
  const sr0Vals  = rows.map((r) => safeNum(r.sr0)).filter((v) => v !== null) as number[];
  const srOoVals = rows.map((r) => safeNum(r.sr_oos_unann)).filter((v) => v !== null) as number[];

  const allZero = dsrVals.length > 0 && dsrVals.every((v) => v === 0);
  const allOne  = dsrVals.length > 0 && dsrVals.every((v) => v === 1);
  const boundaryCount = dsrVals.filter((v) => v < 0.001 || v > 0.999).length;
  const nearBoundary  = dsrVals.length > 0 && boundaryCount / dsrVals.length > 0.9;

  return {
    dsr:  statSummary(dsrVals),
    psr:  statSummary(psrVals),
    sr0:  statSummary(sr0Vals),
    srOo: statSummary(srOoVals),
    allZero,
    allOne,
    nearBoundary,
  };
}

function blockReasonAnalysis(rows: any[]) {
  const patterns = ['unrealistic_sharpe', 'sharpe_out_of_realistic_range'];
  const flagged = rows.filter((r) => {
    const reasons = parseJsonArray(r.block_reasons);
    return reasons.some((s) => patterns.some((p) => s.includes(p)));
  });
  const dsrVals = flagged.map((r) => safeNum(r.dsr)).filter((v) => v !== null) as number[];
  return {
    flagged: flagged.length,
    total: rows.length,
    dsrStat: statSummary(dsrVals),
    samples: flagged.slice(0, 5).map((r) => ({
      symbol:           r.symbol,
      market:           r.market,
      dsr:              safeNum(r.dsr),
      sharpe_deflated:  safeNum(r.sharpe_oos_deflated),
      block_reasons:    parseJsonArray(r.block_reasons).join('; '),
    })),
  };
}

function marketGap(rows: any[], threshold: number) {
  const markets = ['crypto', 'domestic', 'overseas'];
  return Object.fromEntries(
    markets.map((m) => {
      const sub = rows.filter((r) => r.market === m);
      if (!sub.length) return [m, null];
      const dsrVals = sub.map((r) => safeNum(r.dsr)).filter((v) => v !== null) as number[];
      return [m, {
        n:    sub.length,
        flip: flipMatrix(sub, threshold),
        corr: rankCorrelation(sub),
        dsr:  statSummary(dsrVals),
      }];
    }),
  );
}

// ── 콘솔 출력 ─────────────────────────────────────────────────────────

function printReport(total: number, a1: any, a2: any, a3: any, a4: any, a5: any) {
  const fmtStat = (s: any) =>
    `count=${s.count}  min=${fmt(s.min)}  median=${fmt(s.median)}  max=${fmt(s.max)}`;

  console.log(`\n${'─'.repeat(64)}`);
  console.log('1. 판정 뒤집힘 매트릭스 (healthy × dsr≥임계)');
  console.log(`${'─'.repeat(64)}`);
  console.log(`   임계: dsr ≥ ${a1.threshold}  |  유효 행: ${a1.total}/${total}`);
  console.log(`\n   ┌──────────────────────┬──────────┬──────────┐`);
  console.log(`   │                      │ dsr≥임계 │ dsr<임계 │`);
  console.log(`   ├──────────────────────┼──────────┼──────────┤`);
  console.log(`   │ healthy=true  (통과) │ ${String(a1.tp).padStart(5)}건  │ ${String(a1.fp).padStart(5)}건  │  ← fp=${a1.fp}건 과대통과 의심`);
  console.log(`   │ healthy=false (차단) │ ${String(a1.fn).padStart(5)}건  │ ${String(a1.tn).padStart(5)}건  │  ← fn=${a1.fn}건 놓친 기회`);
  console.log(`   └──────────────────────┴──────────┴──────────┘`);

  console.log(`\n${'─'.repeat(64)}`);
  console.log('2. 순위 상관 (sharpe_oos_deflated vs dsr  Spearman ρ)');
  console.log(`${'─'.repeat(64)}`);
  const rhoStr = a2.rho === null ? 'N/A (데이터 부족)' : a2.rho.toFixed(4);
  const rhoTag = a2.rho === null ? '' : a2.rho > 0.8 ? ' → 매우 유사' : a2.rho > 0.5 ? ' → 중간 유사' : ' → 크게 다름';
  console.log(`   ρ = ${rhoStr}${rhoTag}   (유효 쌍: ${a2.n}건)`);

  console.log(`\n${'─'.repeat(64)}`);
  console.log('3. 단위 sanity (per-period 단위 확인)');
  console.log(`${'─'.repeat(64)}`);
  console.log(`   dsr        : ${fmtStat(a3.dsr)}`);
  console.log(`   psr        : ${fmtStat(a3.psr)}`);
  console.log(`   sr0        : ${fmtStat(a3.sr0)}`);
  console.log(`   sr_oos_unann: ${fmtStat(a3.srOo)}`);
  if (a3.allZero)
    console.log(`\n   ⚠️  dsr 전부 0 — 단위 버그 의심 (비연율화 변환 점검)`);
  else if (a3.allOne)
    console.log(`\n   ⚠️  dsr 전부 1 — 단위 버그 의심`);
  else if (a3.nearBoundary)
    console.log(`\n   ⚠️  dsr 90%+ 경계값(0/1 근접) — 포화 의심`);
  else
    console.log(`\n   ✅ dsr 분포 정상 범위`);

  console.log(`\n${'─'.repeat(64)}`);
  console.log('4. 차단 사유 변화 (unrealistic_sharpe 포함 후보)');
  console.log(`${'─'.repeat(64)}`);
  console.log(`   unrealistic_sharpe 포함: ${a4.flagged}건 / 전체 ${a4.total}건`);
  if (a4.flagged > 0) {
    console.log(`   해당 후보 dsr : ${fmtStat(a4.dsrStat)}`);
    console.log('\n   샘플 (최대 5건):');
    for (const s of a4.samples) {
      console.log(`   - ${s.market}/${s.symbol}: dsr=${fmt(s.dsr)}, deflated=${fmt(s.sharpe_deflated)}`);
      if (s.block_reasons) {
        console.log(`     사유: ${s.block_reasons.slice(0, 80)}`);
      }
    }
  } else {
    console.log('   해당 후보 없음');
  }

  console.log(`\n${'─'.repeat(64)}`);
  console.log('5. market별 갭 요약');
  console.log(`${'─'.repeat(64)}`);
  console.log('   market     n   fp   fn    ρ       dsr_median');
  console.log('   ' + '─'.repeat(52));
  for (const [market, d] of Object.entries(a5) as [string, any][]) {
    if (!d) {
      console.log(`   ${market.padEnd(10)} 데이터 없음`);
      continue;
    }
    const rho = d.corr.rho !== null ? d.corr.rho.toFixed(3) : ' N/A ';
    console.log(
      `   ${market.padEnd(10)} ${String(d.n).padStart(3)}  ${String(d.flip.fp).padStart(3)}  ${String(d.flip.fn).padStart(3)}  ${rho.padStart(6)}  ${fmt(d.dsr.median)}`,
    );
  }
  console.log('');
}

// ── 마크다운 리포트 ────────────────────────────────────────────────────

function buildMarkdown(total: number, a1: any, a2: any, a3: any, a4: any, a5: any): string {
  const fmtStat = (s: any) =>
    `count=${s.count}, min=${fmt(s.min)}, median=${fmt(s.median)}, max=${fmt(s.max)}`;

  const rhoStr = a2.rho !== null ? a2.rho.toFixed(4) : 'N/A';
  const rhoTag = a2.rho === null ? 'N/A' : a2.rho > 0.8 ? '매우 유사' : a2.rho > 0.5 ? '중간 유사' : '크게 다름';

  let sanityStatus = '✅ 정상';
  if (a3.allZero) sanityStatus = '⚠️ dsr 전부 0 — 단위 버그 의심';
  else if (a3.allOne) sanityStatus = '⚠️ dsr 전부 1 — 단위 버그 의심';
  else if (a3.nearBoundary) sanityStatus = '⚠️ dsr 90%+ 경계값 — 포화 의심';

  const goSignals: string[] = [];
  const holdSignals: string[] = [];

  if (!a3.allZero && !a3.allOne && !a3.nearBoundary)
    goSignals.push('dsr 분포가 [0,1] 내 합리적 범위 → 단위 정상');
  if (a3.allZero || a3.allOne || a3.nearBoundary)
    holdSignals.push('dsr 단위 버그 의심 — 산출 로직 재검증 필요');

  if (a2.rho !== null && a2.rho > 0.7)
    goSignals.push(`sharpe_oos_deflated와 높은 순위 상관(ρ=${rhoStr}) — 방향 일치`);
  else if (a2.rho !== null && a2.rho < 0.3)
    holdSignals.push(`순위 상관 낮음(ρ=${rhoStr}) — 두 지표 방향 불일치 요인 파악 필요`);

  if (a1.fp > 0)
    goSignals.push(`기존 ${a1.fp}건 과대통과 → DSR로 추가 필터링 가능`);
  if (a1.fn > 0)
    goSignals.push(`기존 ${a1.fn}건 놓친 기회 → DSR로 발굴 가능`);
  if (a1.total < 5)
    holdSignals.push('유효 데이터 5건 미만 — 통계적 판단 어려움');

  const marketRows = Object.entries(a5).map(([m, d]: [string, any]) =>
    d
      ? `| ${m} | ${d.n} | ${d.flip.fp} | ${d.flip.fn} | ${d.corr.rho !== null ? d.corr.rho.toFixed(3) : 'N/A'} | ${fmt(d.dsr.median)} |`
      : `| ${m} | 0 | - | - | - | - |`,
  );

  const sampleRows = a4.samples
    .map(
      (s: any) =>
        `- **${s.market}/${s.symbol}**: dsr=${fmt(s.dsr)}, sharpe_deflated=${fmt(s.sharpe_deflated)}\n  사유: \`${s.block_reasons.slice(0, 100)}\``,
    )
    .join('\n');

  return `# 루나 DSR↔기존 갭 분석 리포트

> 생성: ${TODAY} | DSR 임계(잠정, 전환 시 재검토): ≥${DSR_THRESHOLD} | 데이터: ${total}건

## 1. 판정 뒤집힘 매트릭스

> healthy × dsr≥임계 2×2 교차표. fp=기존 과대통과 의심, fn=놓친 기회.

| | dsr≥${DSR_THRESHOLD} | dsr<${DSR_THRESHOLD} |
|---|---|---|
| **healthy=true (통과)** | ${a1.tp}건 (일치) | **${a1.fp}건 (과대통과 의심)** |
| **healthy=false (차단)** | **${a1.fn}건 (놓친 기회)** | ${a1.tn}건 (일치) |

- 유효 행: ${a1.total}건 (dsr IS NOT NULL)
- 기존 과대통과 의심(fp): **${a1.fp}건**
- 놓친 기회(fn): **${a1.fn}건**

## 2. 순위 상관

> sharpe_oos_deflated 순위 vs dsr 순위의 Spearman ρ. 동순위 평균 순위 처리.

- Spearman ρ = **${rhoStr}** → ${rhoTag}
- 유효 쌍: ${a2.n}건
- ρ 해석: >0.8 매우 유사 / 0.5~0.8 중간 / <0.5 크게 다름

## 3. 단위 sanity

> sr_oos_unann/sr0/dsr 각 통계 + dsr 이상 분포 감지 (전부 0/1 = 단위 버그 신호).

| 지표 | count | min | median | max |
|---|---|---|---|---|
| dsr | ${a3.dsr.count} | ${fmt(a3.dsr.min)} | ${fmt(a3.dsr.median)} | ${fmt(a3.dsr.max)} |
| psr | ${a3.psr.count} | ${fmt(a3.psr.min)} | ${fmt(a3.psr.median)} | ${fmt(a3.psr.max)} |
| sr0 | ${a3.sr0.count} | ${fmt(a3.sr0.min)} | ${fmt(a3.sr0.median)} | ${fmt(a3.sr0.max)} |
| sr_oos_unann | ${a3.srOo.count} | ${fmt(a3.srOo.min)} | ${fmt(a3.srOo.median)} | ${fmt(a3.srOo.max)} |

단위 상태: **${sanityStatus}**

## 4. 차단 사유 변화

> block_reasons에 unrealistic_sharpe/sharpe_out_of_realistic_range 포함 후보의 dsr 분포.
> 기존 cap으로 막힌 후보가 정통 DSR로는 어떻게 평가되는지 확인.

- unrealistic_sharpe 포함: **${a4.flagged}건** / 전체 ${a4.total}건
${a4.flagged > 0 ? `- 해당 후보 dsr 통계: ${fmtStat(a4.dsrStat)}` : '- 해당 후보 없음'}

${a4.samples.length > 0 ? `### 샘플 (최대 5건)\n\n${sampleRows}` : ''}

## 5. market별 갭 요약

| market | n | fp(과대통과) | fn(놓친기회) | Spearman ρ | dsr median |
|---|---|---|---|---|---|
${marketRows.join('\n')}

> domestic: healthy=0이었으므로 fn 주목. crypto: LIVE 운영 중이므로 fp 주목.

## 종합 판단 근거

> **자동 GO/보류 판정 아님** — 메티 검증 + 마스터 최종 결정.

### GO 근거 (전환 지지)
${goSignals.length ? goSignals.map((s) => `- ${s}`).join('\n') : '- 없음'}

### 보류 근거 (전환 유보)
${holdSignals.length ? holdSignals.map((s) => `- ${s}`).join('\n') : '- 없음'}

---

*임계값 ${DSR_THRESHOLD}은 잠정값 — 전환(Phase 1b-2) 시 반드시 재검토.*
*다음 단계: GO → Phase 1b-2(promotion gate에 dsr threshold 반영) / 보류 → dsr 산출 보정 후 재분석.*
`;
}

// ── 메인 ──────────────────────────────────────────────────────────────

async function main() {
  console.log('=== 루나 DSR↔기존 갭 분석 (read-only) ===\n');
  console.log(`DSR 임계(잠정): ≥${DSR_THRESHOLD}  |  날짜: ${TODAY}\n`);

  // dsr IS NOT NULL 행 우선
  const rows = await db.query(`
    SELECT
      symbol, market,
      sharpe_oos_deflated, healthy, gate_status,
      oos_status, block_reasons,
      dsr, psr, sr0, sr_oos_unann, periods_per_year,
      n_grid_trials, total_trades_oos
    FROM investment.candidate_backtest_status
    WHERE dsr IS NOT NULL
    ORDER BY market, symbol
  `);

  if (!rows || rows.length === 0) {
    const [cnt] = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM investment.candidate_backtest_status`,
    );
    console.log(`⚠️  dsr IS NOT NULL 행 없음 (전체 ${cnt?.cnt ?? 0}건)`);
    console.log('   → Phase 1b backfill 완료 후 재실행 필요');
    process.exit(0);
  }

  console.log(`데이터: ${rows.length}건 (dsr IS NOT NULL)\n`);

  const a1 = flipMatrix(rows, DSR_THRESHOLD);
  const a2 = rankCorrelation(rows);
  const a3 = unitSanity(rows);
  const a4 = blockReasonAnalysis(rows);
  const a5 = marketGap(rows, DSR_THRESHOLD);

  printReport(rows.length, a1, a2, a3, a4, a5);

  // 마크다운 리포트 저장
  const outDir = path.resolve(new URL('../output', import.meta.url).pathname);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `luna-dsr-gap-report-${TODAY}.md`);
  const md = buildMarkdown(rows.length, a1, a2, a3, a4, a5);
  fs.writeFileSync(outPath, md, 'utf8');
  console.log(`✅ 리포트 저장: ${outPath}`);

  process.exit(0);
}

main().catch((e) => {
  console.error('❌ 분석 실패:', e?.message || String(e));
  process.exit(1);
});
