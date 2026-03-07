#!/bin/bash
# scripts/chaos/test-emergency-mode.sh
# 장애 주입 5: 덱스터 비상 모드 전환 테스트
#
# DexterMode 클래스의 비상 진입/해제 동작 확인
set -e

cd "$(dirname "$0")/../.."
echo "=============================="
echo "🔥 장애 주입 5: 덱스터 비상 모드 전환"
echo "=============================="
echo ""

echo "[$(date '+%H:%M:%S')] 비상 모드 전환 테스트..."
node -e "
  const { DexterMode } = require('./bots/claude/lib/dexter-mode');
  const dm = new DexterMode();

  let ok = true;

  // 1. 초기 상태
  const initial = dm.currentMode;
  const initEmg = dm.isEmergency();
  console.log('1) 초기 모드:', initial, '/ 비상:', initEmg);
  if (initEmg) { console.log('  ⚠️ 이미 비상 모드 — 테스트 신뢰도 낮음'); }

  // 2. 비상 진입 (OpenClaw 다운 시뮬레이션)
  dm.checkModeTransition(false, true);  // openclawOk=false, skayaOk=true
  const afterDown = dm.isEmergency();
  console.log('2) OpenClaw 다운 후:', dm.currentMode, '/ 비상:', afterDown);

  // 3. 비상 상태에서 밀린 알림 버퍼 확인
  const pending = dm.pendingAlerts || [];
  console.log('3) 대기 알림 수:', Array.isArray(pending) ? pending.length : 'N/A');

  // 4. 복구 → 비상 해제
  dm.checkModeTransition(true, true);   // openclawOk=true, skayaOk=true
  const afterRecover = dm.isEmergency();
  console.log('4) 복구 후:', dm.currentMode, '/ 비상:', afterRecover);

  // 5. 검증
  if (!afterDown) {
    console.log('⚠️ OpenClaw 다운 시 비상 모드 미전환 — dexter-mode.js 로직 확인 필요');
    ok = false;
  }
  if (afterRecover) {
    console.log('⚠️ 복구 후에도 비상 모드 유지 — dexter-mode.js 로직 확인 필요');
    ok = false;
  }

  console.log('');
  console.log(ok ? '✅ 비상 모드 전환/해제 정상' : '⚠️ 일부 항목 확인 필요');
  process.exit(0);
"

# 덱스터 퀵체크로 현재 상태 최종 확인
echo ""
echo "[$(date '+%H:%M:%S')] 덱스터 퀵체크로 현재 상태 재확인..."
node bots/claude/src/dexter-quickcheck.js 2>&1 | grep -E "(종합|비상|emergency|OK|WARN|ERROR)" | head -5 || true

echo ""
echo "[$(date '+%H:%M:%S')] ✅ 테스트 완료"
