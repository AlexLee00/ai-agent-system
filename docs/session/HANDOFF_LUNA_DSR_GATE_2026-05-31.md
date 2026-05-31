# 핸드오프: 루나 DSR 게이트 (Phase 1 완료) → 다음 페이즈

> 세션 마감: 2026-05-31. 작성: 메티. 다음 세션에서 다음 페이즈 진행.
> 3역할: 메티(설계·검증·문서) · 코덱스(구현) · 마스터(승인·실행)

## 1. 이번 세션 결과 — DSR 게이트 구현·커밋 완료

루나 백테스팅 정밀화 Phase 1 (Deflated Sharpe Ratio 게이트).

### 커밋 이력 (전부 main + origin/main 동기화)
- 63f466c8f  Phase 1b DSR/PSR 정통 산출 (FST 공식, 단위 일관성, SHADOW)
- d1565df2f  DSR↔기존 갭 분석 스크립트
- 35e472ec7  Phase 1b-2 DSR 판정 게이트 전환 (환경변수 기본 OFF)
- 7f47a8915  DSR 게이트 안전장치 보강 (dsr null 처리)
- 84c78b801  plist 환경변수 (LUNA_DSR_GATE_ENABLED=true)
- adc65b2ca  옵션 C — entry-trigger 실거래 차단에 DSR 게이트 적용
- ab8544c89  DSR 차단은 notify 모드에서도 하드블록 (보강)

### 구현 3계층
1. dsr 산출: scripts/backtest-vectorbt.py
   - probabilistic_sharpe_ratio / expected_max_sharpe / periods_per_year
   - 단위 일관성(연율화→비연율화), FST(Lopez de Prado) 공식
   - → candidate_backtest_status.dsr/psr/sr0/sr_oos_unann/periods_per_year 저장
2. gate.ts 게이트: shared/candidate-backtest-gate.ts
   - dsrWouldBlock = dsrGateActive && dsr != null && (거래<30 || dsr<0.90)
   - LUNA_DSR_GATE_ENABLED(기본 OFF) / LUNA_DSR_MIN(0.90) / LUNA_DSR_MIN_TRADES(30)
3. entry-trigger 실거래 차단: shared/entry-trigger-engine.ts (옵션 C)
   - candidate_backtest_status에서 dsr/total_trades_oos SELECT
   - applyBacktestGateEvaluation → gate.ts evaluateCandidateBacktestStatus 재판정
   - evaluatedHealthy = wouldBlock ? false : healthy (동적 차단)
   - notify 보강(:351): DSR 사유는 notify 모드에서도 hardBlock=true, ok=false

### dry 테스트 입증 (gate.ts 순수 함수)
- 088350(dsr0.857, 거래17) ON → wouldBlock=true [insufficient_trades(17<30), dsr_low(0.857<0.9)]
- AUUD(dsr0.916, 거래45) ON → false (keep)
- crypto(dsr null) ON → false (live 보호)
- 088350 OFF → false (기존 동작 불변)

## 2. 작동 경로
ops-scheduler(60초, StartInterval) → entry-trigger-worker spawnSync 스폰(env:{...process.env} 상속) → entry-trigger-engine이 candidate_backtest_status.dsr 읽어 dsr<0.90 || 거래<30 동적 would_block + notify hardBlock
- plist 2개에 LUNA_DSR_GATE_ENABLED=true: ai.luna.candidate-backtest-refresh + ai.luna.ops-scheduler (launchctl print 반영 확인)

## 3. 핵심 발견 (다음 세션 필수 인지)
- 데이터 단절: refresh의 healthy 계산은 buildOhlcvMomentumBacktestRows(즉석 모멘텀 백테스팅) 기반 → dsr/sharpe_oos 없음. dsr은 별도 경로(vectorbt/backfill)로 candidate_backtest_status 컬럼에만 저장. refresh.ts:730-736 dsr 게이트는 avgDsr=null로 작동 불가(healthy 컬럼은 dsr 미반영, 비크립토 4 유지). → 옵션 C(entry-trigger 동적 차단)로 우회 해결.
- 갭 분석 결론(본질): 진짜 문제는 지표가 아니라 전략 부적합. healthy 4 중 거래충분+고SR 동시만족은 AUUD뿐, 나머지는 소표본 과신. DSR/CPCV 가드레일은 나쁜 후보를 거를 뿐 좋은 후보를 못 만듦. healthy 후보 부족은 Phase 2(meta-labeling/regime)가 본질.
- 수동 실행 함정: plist env는 launchd 실행 시만 적용. 수동 tsx 실행 시 LUNA_DSR_GATE_ENABLED 누락 → 게이트 OFF. launchd kickstart 또는 env 명시 필요.

## 4. 미해결 / 이월
- 운영 관측(백그라운드): 다음 ops-scheduler/entry-trigger 주기에서 active trigger가 DSR 대상(거래<30 또는 dsr<0.90)에 걸리면 quality gate 메타/guard event에 candidate_backtest_dsr_gate / candidate_backtest_insufficient_trades 기록되는지 확인. crypto(binance/upbit) 무중단 확인.
- healthy 컬럼 dsr 미반영(선택): 실거래는 옵션 C로 차단되나 candidate_backtest_status.healthy 표시값은 dsr 미반영(4). 표시까지 맞추려면 refresh가 저장된 dsr을 healthy 계산에 반영하는 추가 작업. 우선순위 판단.
- 미커밋: output/*.json 3개(luna-fundamental-quant-shadow, luna-korean-factor-refresh, luna-opendart-financial-batch-refresh) + darwin-keywords.json — 자동 생성/범위 밖.

## 5. 다음 페이즈 후보 (마스터 선택)
설계: docs/strategy/LUNA_BACKTEST_EVOLUTION_DESIGN_2026-05-31.md 로드맵
- Phase 1c (CPCV/PBO): 가드레일 연장. Combinatorial Purged CV + 과적합확률(PBO). cpcv-validation 스킬. DSR과 같은 계열 → 흐름 연속.
- Phase 2 (meta-labeling/regime): 본질 과제. healthy 후보 부족 직접 해결. 임팩트 큼. (기존 A2A shadow skills 활용: market-regime-analysis, meta-neural-reflexion 등)
- 메티 권고: 임팩트는 Phase 2, 로드맵 순서는 Phase 1c. 우선순위 판단.

## 6. 불변 원칙 (다음 세션 유지)
- 3역할: 메티(claude.ai, 설계·검증·문서·CODEX 작성, 코드/plist/launchd/DB/git 직접 실행 금지) · 코덱스(Claude Code CLI 구현) · 마스터(승인·실행)
- DEV(맥북에어)/OPS(맥스튜디오 24/7) 분리. 모든 구현 DEV. OPS 직접 수정 금지
- 게이트 기본 OFF (kill switch). 검증 후 활성화
- crypto live(binance/upbit) 무중단 비협상. dsr null → crypto 영향 0
- PROTECTED launchd reload/plist는 마스터. CODEX는 docs/codex/ → 마스터 검토 → 코덱스 구현 → 메티 검증 → 마스터 승인
- DB명 jay, investment 스키마. 경로 /Users/alexlee/projects/ai-agent-system. 한국어
