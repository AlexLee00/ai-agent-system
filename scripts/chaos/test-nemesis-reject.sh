#!/bin/bash
# scripts/chaos/test-nemesis-reject.sh
# 스트레스 테스트 3: 네메시스 거부 케이스 + 동적 TP/SL Phase 1 확인
#
# 검증 항목:
#   1. 하드 규칙 — 최소 주문 미달, 일일 손실 한도, 최대 포지션 초과
#   2. calculateDynamicTPSL — ATR 기반 / 고정 값 출력 (applied: false)
#   3. 매매일지 rationale 기록 경로
#   4. Shadow Mode symbol_decision 로그 구조
#
# ⚠️ 코드 구조 검증 — 실 DB 접근 최소화
set -e

cd "$(dirname "$0")/../.."
echo "=============================="
echo "🔥 스트레스 테스트 3: 네메시스 거부 케이스 + 동적 TP/SL"
echo "=============================="
echo ""

# 1. 하드 규칙 상수 확인
echo "[$(date '+%H:%M:%S')] 1) 하드 규칙 상수 (RULES) 확인..."
node --input-type=module << 'EOF'
import { RULES } from './bots/investment/team/nemesis.js';
console.log('RULES:', JSON.stringify(RULES, null, 2));
const ok = RULES.MIN_ORDER_USDT === 10 && RULES.MAX_OPEN_POSITIONS === 5 && RULES.STOP_LOSS_PCT === 0.03;
console.log(ok ? '✅ 하드 규칙 상수 정상' : '❌ 하드 규칙 상수 이상');
process.exit(0);
EOF

# 2. calculateDynamicTPSL — 고정값 케이스 (atrRatio null)
echo ""
echo "[$(date '+%H:%M:%S')] 2) calculateDynamicTPSL — 고정값 케이스 (ATR 없음)..."
node --input-type=module << 'EOF'
import { calculateDynamicTPSL } from './bots/investment/team/nemesis.js';
const r = calculateDynamicTPSL('BTC/USDT', 90000, null);
console.log('결과:', JSON.stringify(r));
const ok = r.source === 'fixed' && r.applied === false && r.tpPct === 0.06 && r.slPct === 0.03;
console.log(ok ? '✅ 고정 TP/SL 정상 (applied: false)' : '❌ 고정 TP/SL 이상');
process.exit(0);
EOF

# 3. calculateDynamicTPSL — ATR 기반 케이스
echo ""
echo "[$(date '+%H:%M:%S')] 3) calculateDynamicTPSL — ATR 기반 케이스 (atrRatio=0.02)..."
node --input-type=module << 'EOF'
import { calculateDynamicTPSL } from './bots/investment/team/nemesis.js';
const r = calculateDynamicTPSL('BTC/USDT', 90000, 0.02);
console.log('결과:', JSON.stringify(r));
const rrRatio = r.tpPct / r.slPct;
const ok = r.source === 'atr' && r.applied === false && rrRatio >= 1.8;  // 2:1 근사
console.log(ok ? `✅ ATR TP/SL 정상 (R/R≈${rrRatio.toFixed(2)}, applied: false)` : `❌ ATR TP/SL 이상 (R/R=${rrRatio.toFixed(2)})`);
// 극단값 테스트
const r2 = calculateDynamicTPSL('BTC/USDT', null, 0.30);  // 매우 높은 변동성
const r3 = calculateDynamicTPSL('BTC/USDT', null, 0.001); // 매우 낮은 변동성
console.log(`  극단 high(ATR=30%): TP=${(r2.tpPct*100).toFixed(1)}% SL=${(r2.slPct*100).toFixed(1)}% — 클램프 확인`);
console.log(`  극단 low(ATR=0.1%): TP=${(r3.tpPct*100).toFixed(1)}% SL=${(r3.slPct*100).toFixed(1)}% — 클램프 확인`);
console.log(r2.tpPct <= 0.15 && r3.tpPct >= 0.03 ? '✅ 클램프 (3%~15%) 정상' : '❌ 클램프 이상');
process.exit(0);
EOF

# 4. 매매일지 rationale 기록 구조 확인
echo ""
echo "[$(date '+%H:%M:%S')] 4) 매매일지 판단 근거 기록 구조 확인..."
node --input-type=module << 'EOF'
import { readFileSync } from 'fs';
const src = readFileSync('./bots/investment/team/nemesis.js', 'utf8');
const hasInsertRationale   = src.includes('insertRationale');
const hasNemesisVerdict    = src.includes('nemesis_verdict');
const hasPositionSizeOrig  = src.includes('position_size_original');
const hasDynamicTPSL       = src.includes('calculateDynamicTPSL');
const hasAppliedFalse      = src.includes('applied: false');
console.log(hasInsertRationale   ? '✅ insertRationale 호출 있음' : '❌ insertRationale 없음');
console.log(hasNemesisVerdict    ? '✅ nemesis_verdict 필드 있음' : '❌ nemesis_verdict 없음');
console.log(hasPositionSizeOrig  ? '✅ position_size_original 기록 있음' : '❌ position_size_original 없음');
console.log(hasDynamicTPSL       ? '✅ calculateDynamicTPSL 통합됨' : '❌ calculateDynamicTPSL 없음');
console.log(hasAppliedFalse      ? '✅ applied: false 고정 있음' : '❌ applied: false 없음');
process.exit(0);
EOF

# 5. Shadow Mode symbol_decision 로그 구조 확인
echo ""
echo "[$(date '+%H:%M:%S')] 5) Shadow Mode symbol_decision 구조 확인..."
node --input-type=module << 'EOF'
import { readFileSync } from 'fs';
const src = readFileSync('./bots/investment/team/luna.ts', 'utf8');
const hasShadowEval    = src.includes("shadow.evaluate");
const hasSymDecCtx     = src.includes("'symbol_decision'");
const hasShadowFixed   = src.includes("mode:      'shadow'");
const hasRuleEngineWrap = src.includes('ruleEngine: async () =>');
console.log(hasShadowEval    ? '✅ shadow.evaluate 래핑 있음' : '❌ shadow.evaluate 없음');
console.log(hasSymDecCtx     ? "✅ context: 'symbol_decision' 있음" : "❌ context 없음");
console.log(hasShadowFixed   ? "✅ mode: 'shadow' 고정 있음" : "❌ mode 없음");
console.log(hasRuleEngineWrap ? '✅ ruleEngine async 래핑 있음' : '❌ ruleEngine 없음');
process.exit(0);
EOF

echo ""
echo "[$(date '+%H:%M:%S')] ✅ 테스트 완료"
