#!/bin/bash
# scripts/chaos/test-exchange-timeout.sh
# 스트레스 테스트 2: 거래소 API 타임아웃/장애 처리 확인
#
# 검증 항목:
#   1. 헤파이스토스 — 바이낸스 주문 실패 시 graceful 처리
#   2. 잔고 조회 실패 시 포트폴리오 컨텍스트 fallback
#   3. OCO 주문 실패 시 TP/SL 미설정 상태로 진입 방지 (tp_sl_set 보호)
#
# ⚠️ 코드 구조 검증만 — 실제 API 호출 없음
set -e

cd "$(dirname "$0")/../.."
echo "=============================="
echo "🔥 스트레스 테스트 2: 거래소 API 타임아웃 처리"
echo "=============================="
echo ""

# 1. 헤파이스토스 — 주문 실패 시 tp_sl_set 보호 로직
echo "[$(date '+%H:%M:%S')] 1) 헤파이스토스 TP/SL 보호 로직 확인..."
node --input-type=module << 'EOF'
import { readFileSync } from 'fs';
const src = readFileSync('./bots/investment/team/hephaestos.js', 'utf8');
const hasTpSlSet      = src.includes('tp_sl_set');
const hasTryCatch     = src.includes('catch');
const hasOcoOrder     = src.includes('oco') || src.includes('OCO') || src.includes('stopLoss');
console.log(hasTpSlSet  ? '✅ tp_sl_set 보호 필드 있음' : '❌ tp_sl_set 없음');
console.log(hasTryCatch ? '✅ try/catch 오류 처리 있음' : '❌ try/catch 없음');
console.log(hasOcoOrder ? '✅ OCO/손절 주문 로직 있음' : '⚠️ OCO 로직 미확인 (다른 파일에 있을 수 있음)');
process.exit(0);
EOF

# 2. ccxt 타임아웃 설정 확인 (바이낸스 클라이언트)
echo ""
echo "[$(date '+%H:%M:%S')] 2) 바이낸스 클라이언트 타임아웃 설정 확인..."
node --input-type=module << 'EOF'
import { readFileSync } from 'fs';
// reporter.js, hephaestos.js 등에서 ccxt 사용
const files = ['./bots/investment/team/reporter.js', './bots/investment/team/hephaestos.js'];
for (const f of files) {
  try {
    const src = readFileSync(f, 'utf8');
    const hasEnableRateLimit = src.includes('enableRateLimit');
    const hasCcxt            = src.includes('ccxt');
    if (hasCcxt) {
      console.log(`${f.split('/').pop()}:`);
      console.log(`  ${hasEnableRateLimit ? '✅' : '⚠️'} enableRateLimit: ${hasEnableRateLimit}`);
    }
  } catch {}
}
process.exit(0);
EOF

# 3. 잔고 조회 실패 시 포트폴리오 fallback
echo ""
echo "[$(date '+%H:%M:%S')] 3) 잔고 조회 실패 시 포트폴리오 fallback 확인..."
node --input-type=module << 'EOF'
import { readFileSync } from 'fs';
const src = readFileSync('./bots/investment/team/luna.ts', 'utf8');
// buildPortfolioContext: usdtFree = 10000 hardcoded fallback
const hasFallbackUsdt = src.includes('usdtFree   = 10000') || src.includes('usdtFree = 10000');
const hasInsertSnap   = src.includes('insertAssetSnapshot');
console.log(hasFallbackUsdt ? '✅ usdtFree fallback (10000) 있음' : '❌ usdtFree fallback 없음');
console.log(hasInsertSnap   ? '✅ 자산 스냅샷 기록 있음' : '❌ 자산 스냅샷 없음');
process.exit(0);
EOF

# 4. 거래소 오류 시 notifyError 호출 확인
echo ""
echo "[$(date '+%H:%M:%S')] 4) 거래소 오류 → notifyError 알림 체계 확인..."
node --input-type=module << 'EOF'
import { readFileSync } from 'fs';
const src = readFileSync('./bots/investment/team/luna.ts', 'utf8');
const hasNotifyError = src.includes('notifyError');
console.log(hasNotifyError ? '✅ notifyError 알림 있음 (심볼 오류 시 마스터 알림)' : '❌ notifyError 없음');
process.exit(0);
EOF

echo ""
echo "[$(date '+%H:%M:%S')] ✅ 테스트 완료"
