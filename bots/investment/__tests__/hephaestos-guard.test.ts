// @ts-nocheck
/**
 * SEC-004: Hephaestos executeSignal 네메시스 재검증 가드 단위 테스트
 * 실행: tsx bots/investment/__tests__/hephaestos-guard.test.ts
 *
 * DB 연결 없이 순수 로직만 테스트 (모킹 방식)
 */

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

// ─── 가드 로직 인라인 (hephaestos.ts executeSignal과 동일) ───────────────────

function checkNemesisGuard(signal: any, globalPaperMode: boolean): { blocked: boolean; code?: string; reason?: string } {
  const nemesisVerdict = signal.nemesis_verdict || signal.nemesisVerdict;
  const isApproved = ['approved', 'modified'].includes(String(nemesisVerdict || '').toLowerCase());

  if (!globalPaperMode && !isApproved) {
    return {
      blocked: true,
      code: 'sec004_nemesis_bypass_guard',
      reason: `SEC-004: 네메시스 승인 없는 signal 실행 차단 (verdict=${nemesisVerdict || 'null'})`,
    };
  }

  if (!globalPaperMode && signal.approved_at) {
    const ageMs = Date.now() - new Date(signal.approved_at).getTime();
    if (ageMs > 5 * 60 * 1000) {
      return {
        blocked: true,
        code: 'sec004_stale_approval',
        reason: `SEC-004: 승인 후 ${Math.round(ageMs / 1000)}초 경과 (stale signal)`,
      };
    }
  }

  return { blocked: false };
}

// ─── 테스트 케이스 ────────────────────────────────────────────────────────────

console.log('\n[SEC-004] Hephaestos 네메시스 재검증 가드 테스트\n');

// 1. LIVE 모드, verdict 없음 → 차단
{
  const result = checkNemesisGuard({ symbol: 'BTC/USDT', action: 'BUY' }, false);
  assert(result.blocked === true, 'LIVE + verdict=null → 차단');
  assert(result.code === 'sec004_nemesis_bypass_guard', '차단 코드 = sec004_nemesis_bypass_guard');
}

// 2. LIVE 모드, verdict='rejected' → 차단
{
  const result = checkNemesisGuard({ symbol: 'BTC/USDT', action: 'BUY', nemesis_verdict: 'rejected' }, false);
  assert(result.blocked === true, 'LIVE + verdict=rejected → 차단');
}

// 3. LIVE 모드, verdict='approved' → 통과
{
  const freshAt = new Date(Date.now() - 30_000).toISOString(); // 30초 전
  const result = checkNemesisGuard({ symbol: 'BTC/USDT', action: 'BUY', nemesis_verdict: 'approved', approved_at: freshAt }, false);
  assert(result.blocked === false, 'LIVE + verdict=approved + fresh → 통과');
}

// 4. LIVE 모드, verdict='modified' → 통과
{
  const freshAt = new Date(Date.now() - 60_000).toISOString(); // 1분 전
  const result = checkNemesisGuard({ symbol: 'ETH/USDT', action: 'SELL', nemesis_verdict: 'modified', approved_at: freshAt }, false);
  assert(result.blocked === false, 'LIVE + verdict=modified + fresh → 통과');
}

// 5. LIVE 모드, 승인 후 6분 경과 (stale) → 차단
{
  const staleAt = new Date(Date.now() - 6 * 60 * 1000).toISOString(); // 6분 전
  const result = checkNemesisGuard({ symbol: 'BTC/USDT', action: 'BUY', nemesis_verdict: 'approved', approved_at: staleAt }, false);
  assert(result.blocked === true, 'LIVE + verdict=approved + stale(6분) → 차단');
  assert(result.code === 'sec004_stale_approval', '차단 코드 = sec004_stale_approval');
}

// 6. PAPER 모드, verdict 없음 → 통과 (guard 우회)
{
  const result = checkNemesisGuard({ symbol: 'BTC/USDT', action: 'BUY' }, true);
  assert(result.blocked === false, 'PAPER + verdict=null → 통과 (페이퍼 모드 예외)');
}

// 7. PAPER 모드, stale approval → 통과 (guard 우회)
{
  const staleAt = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10분 전
  const result = checkNemesisGuard({ symbol: 'BTC/USDT', action: 'BUY', nemesis_verdict: 'approved', approved_at: staleAt }, true);
  assert(result.blocked === false, 'PAPER + stale → 통과 (페이퍼 모드 예외)');
}

// 8. 대소문자 비구분 verdict ('Approved') → 통과
{
  const freshAt = new Date(Date.now() - 10_000).toISOString();
  const result = checkNemesisGuard({ symbol: 'BTC/USDT', action: 'BUY', nemesis_verdict: 'Approved', approved_at: freshAt }, false);
  assert(result.blocked === false, 'LIVE + verdict=Approved(대문자) → 통과 (toLowerCase 처리)');
}

// 9. camelCase 필드명 (nemesisVerdict) → 차단
{
  const result = checkNemesisGuard({ symbol: 'BTC/USDT', action: 'BUY', nemesisVerdict: undefined }, false);
  assert(result.blocked === true, 'LIVE + nemesisVerdict=undefined → 차단');
}

// ─── 결과 ─────────────────────────────────────────────────────────────────────

console.log(`\n결과: ${passed}/${passed + failed} 통과${failed > 0 ? ` (${failed}개 실패)` : ''}\n`);
if (failed > 0) {
  process.exit(1);
}
