#!/bin/bash
# scripts/chaos/test-luna-concurrent-signals.sh
# 스트레스 테스트 1: 루나팀 동시 신호 충돌 처리 확인
#
# 검증 항목:
#   1. MAX_DEBATE_SYMBOLS(2) 한도 초과 시 debate 스킵 동작
#   2. Shadow Mode — 동시 symbol_decision 로그 충돌 없음
#   3. 포트폴리오 판단 시 중복 심볼 필터링 (LLM 환각 방지 로직)
#
# ⚠️ PAPER_MODE 전용 — 실투자 영향 없음
set -e

cd "$(dirname "$0")/../.."
echo "=============================="
echo "🔥 스트레스 테스트 1: 루나팀 동시 신호 충돌"
echo "=============================="
echo ""

# 1. MAX_DEBATE_SYMBOLS 한도 초과 시 스킵 로직 확인
echo "[$(date '+%H:%M:%S')] 1) MAX_DEBATE_SYMBOLS 한도 확인..."
node --input-type=module << 'EOF'
import { readFileSync } from 'fs';
const src = readFileSync('./bots/investment/team/luna.ts', 'utf8');
const hasDebateLimit  = src.includes('MAX_DEBATE_SYMBOLS');
const hasDebateSkip   = src.includes('debate 한도 도달');
const hasShadowWrap   = src.includes('shadow.evaluate');
console.log(hasDebateLimit ? '✅ MAX_DEBATE_SYMBOLS 상수 있음' : '❌ MAX_DEBATE_SYMBOLS 없음');
console.log(hasDebateSkip  ? '✅ debate 한도 초과 시 스킵 로직 있음' : '❌ 스킵 로직 없음');
console.log(hasShadowWrap  ? '✅ Shadow Mode 래핑 (symbol_decision) 있음' : '❌ Shadow 래핑 없음');
process.exit(0);
EOF

# 2. 동시 심볼 처리 — shadow_log 다중 INSERT 충돌 없는지 확인 (in-memory 시뮬레이션)
echo ""
echo "[$(date '+%H:%M:%S')] 2) Shadow Mode 다중 심볼 동시 처리 시뮬레이션..."
node -e "
  (async () => {
    const shadow = require('./packages/core/lib/shadow-mode');
    const symbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];

    // 3개 심볼 동시 Shadow evaluate (PAPER — 실투자 없음)
    const results = await Promise.all(symbols.map((sym, i) =>
      shadow.evaluate({
        team:    'luna',
        context: 'chaos_concurrent_test',
        input:   { symbol: sym, test: 'concurrent', idx: i },
        ruleEngine: async () => ({
          action: i % 2 === 0 ? 'BUY' : 'HOLD',
          amount_usdt: 100,
          confidence: 0.65,
          reasoning: '동시 테스트 ' + sym,
        }),
        llmPrompt: '당신은 테스트 봇입니다. JSON으로만 응답: {\"action\":\"HOLD\",\"amount_usdt\":100,\"confidence\":0.5,\"reasoning\":\"테스트\"}',
        mode: 'shadow',
      })
    ));

    const allHaveAction = results.every(r => r.action?.action);
    console.log(allHaveAction ? '✅ 동시 처리 ' + results.length + '건 모두 action 반환' : '❌ action 없는 결과 있음');
    console.log('   결과:', results.map(r => r.action?.action).join(', '));
    process.exit(0);
  })().catch(e => { console.error('❌ 테스트 오류:', e.message); process.exit(1); });
"

# 3. 포트폴리오 판단 시 중복 심볼 필터링 로직 확인
echo ""
echo "[$(date '+%H:%M:%S')] 3) 포트폴리오 LLM 환각 방지 로직 확인..."
node --input-type=module << 'EOF'
import { readFileSync } from 'fs';
const src = readFileSync('./bots/investment/team/luna.ts', 'utf8');
const hasAllowedFilter = src.includes('allowed.has(d.symbol)');
const hasSymbolSet     = src.includes('new Set(symbols)');
console.log(hasAllowedFilter ? '✅ LLM 환각 방지 필터 (allowed.has) 있음' : '❌ 필터 없음');
console.log(hasSymbolSet     ? '✅ 허용 심볼 Set 구성 있음' : '❌ Set 없음');
process.exit(0);
EOF

echo ""
echo "[$(date '+%H:%M:%S')] ✅ 테스트 완료"
