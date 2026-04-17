// @ts-nocheck
/**
 * SEC-004: Hephaestos executeSignal 네메시스 재검증 가드 단위 테스트
 * 실행: tsx bots/investment/__tests__/hephaestos-guard.test.ts
 *
 * DB 연결 없이 순수 로직만 테스트 (모킹 방식)
 */

const ACTIONS = { BUY: 'BUY', SELL: 'SELL', HOLD: 'HOLD' };

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
  const { action } = signal;

  // SELL은 포지션 청산이므로 가드 예외
  if (action === ACTIONS.SELL || globalPaperMode) {
    return { blocked: false };
  }

  const nemesisVerdict = signal.nemesis_verdict || signal.nemesisVerdict;
  const isApproved = ['approved', 'modified'].includes(String(nemesisVerdict || '').toLowerCase());

  if (!isApproved) {
    return {
      blocked: true,
      code: 'sec004_nemesis_bypass_guard',
      reason: `SEC-004: 네메시스 승인 없는 BUY signal 실행 차단 (verdict=${nemesisVerdict || 'null'})`,
    };
  }

  if (signal.approved_at) {
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

// ── BUY 차단 케이스 ───────────────────────────────────────────────────────────
{
  const r = checkNemesisGuard({ symbol: 'BTC/USDT', action: 'BUY' }, false);
  assert(r.blocked === true, 'LIVE BUY + verdict=null → 차단');
  assert(r.code === 'sec004_nemesis_bypass_guard', '차단 코드 = sec004_nemesis_bypass_guard');
}

{
  const r = checkNemesisGuard({ symbol: 'BTC/USDT', action: 'BUY', nemesis_verdict: 'rejected' }, false);
  assert(r.blocked === true, 'LIVE BUY + verdict=rejected → 차단');
}

{
  const staleAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  const r = checkNemesisGuard({ symbol: 'BTC/USDT', action: 'BUY', nemesis_verdict: 'approved', approved_at: staleAt }, false);
  assert(r.blocked === true, 'LIVE BUY + verdict=approved + stale(6분) → 차단');
  assert(r.code === 'sec004_stale_approval', '차단 코드 = sec004_stale_approval');
}

{
  const r = checkNemesisGuard({ symbol: 'BTC/USDT', action: 'BUY', nemesisVerdict: undefined }, false);
  assert(r.blocked === true, 'LIVE BUY + nemesisVerdict=undefined(camelCase) → 차단');
}

// ── BUY 통과 케이스 ───────────────────────────────────────────────────────────
{
  const freshAt = new Date(Date.now() - 30_000).toISOString();
  const r = checkNemesisGuard({ symbol: 'BTC/USDT', action: 'BUY', nemesis_verdict: 'approved', approved_at: freshAt }, false);
  assert(r.blocked === false, 'LIVE BUY + verdict=approved + fresh → 통과');
}

{
  const freshAt = new Date(Date.now() - 60_000).toISOString();
  const r = checkNemesisGuard({ symbol: 'ETH/USDT', action: 'BUY', nemesis_verdict: 'modified', approved_at: freshAt }, false);
  assert(r.blocked === false, 'LIVE BUY + verdict=modified + fresh → 통과');
}

{
  const freshAt = new Date(Date.now() - 10_000).toISOString();
  const r = checkNemesisGuard({ symbol: 'BTC/USDT', action: 'BUY', nemesis_verdict: 'Approved', approved_at: freshAt }, false);
  assert(r.blocked === false, 'LIVE BUY + verdict=Approved(대문자) → 통과 (toLowerCase)');
}

// ── SELL 예외 케이스 (force-exit) ─────────────────────────────────────────────
{
  // SELL은 verdict 없어도 항상 통과
  const r = checkNemesisGuard({ symbol: 'BTC/USDT', action: 'SELL' }, false);
  assert(r.blocked === false, 'LIVE SELL + verdict=null → 통과 (SELL 예외)');
}

{
  const staleAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const r = checkNemesisGuard({ symbol: 'BTC/USDT', action: 'SELL', nemesis_verdict: null, approved_at: staleAt }, false);
  assert(r.blocked === false, 'LIVE SELL + stale → 통과 (SELL 예외)');
}

{
  // force-exit-runner가 추가하는 nemesis_verdict='approved' 케이스도 통과
  const r = checkNemesisGuard({ symbol: 'BTC/USDT', action: 'SELL', nemesis_verdict: 'approved', approved_at: new Date().toISOString() }, false);
  assert(r.blocked === false, 'LIVE SELL + verdict=approved (force-exit) → 통과');
}

// ── PAPER 모드 예외 ───────────────────────────────────────────────────────────
{
  const r = checkNemesisGuard({ symbol: 'BTC/USDT', action: 'BUY' }, true);
  assert(r.blocked === false, 'PAPER BUY + verdict=null → 통과 (페이퍼 모드)');
}

{
  const staleAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const r = checkNemesisGuard({ symbol: 'BTC/USDT', action: 'BUY', nemesis_verdict: 'approved', approved_at: staleAt }, true);
  assert(r.blocked === false, 'PAPER BUY + stale → 통과 (페이퍼 모드)');
}

// ── CLI 어드민 bypass 케이스 ──────────────────────────────────────────────────
{
  // CLI는 nemesis_verdict: 'approved', approved_at: now 를 직접 주입
  const r = checkNemesisGuard({ symbol: 'BTC/USDT', action: 'BUY', nemesis_verdict: 'approved', approved_at: new Date().toISOString() }, false);
  assert(r.blocked === false, 'LIVE BUY + CLI 어드민 bypass (verdict=approved, now) → 통과');
}

// ─── 결과 ─────────────────────────────────────────────────────────────────────

console.log(`\n결과: ${passed}/${passed + failed} 통과${failed > 0 ? ` (${failed}개 실패)` : ''}\n`);
if (failed > 0) {
  process.exit(1);
}
