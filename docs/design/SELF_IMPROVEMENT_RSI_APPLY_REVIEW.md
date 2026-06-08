# 자기개선 보강안 — 코드 대조 정밀 검토 (SI-01~08)

> 작성: 메티 · 날짜: 2026-06-08 · 짝: SELF_IMPROVEMENT_RSI_BOOST.md
> 형식: ① 기존 실측(file:line) ② Δ 3분류(기존/비활성/신규) ③ 적용 정밀(advisory vs 경계·무중단·테스트) ④ 리스크/순서
> **총평**: 자기개선·안전 인프라가 **예상보다 완비**. 보강 다수가 정렬·감사·경계 명시, 진짜 신규는 소수(그룹상대변이·증거번들·단일변수 enforcement·드리프트).

---
### SI-01. 검증가능 보상 정렬 (RLVR) — 강력권장
**기존**: `python/rl/luna_trading_env.py:99` `reward = pnl − trade_cost − drawdown×0.6(drawdown_penalty) − |action|×0.02(trade_penalty)` + equity_peak 추적(HWM 유사) + `shadow_only:True`. `train-luna-ppo.py:60 evaluate_model`=total/avg_reward·positive_steps(**인-샘플**). → **보상 이미 위험조정**.
**Δ**: 기존=위험조정 보상(drawdown/trade 페널티)·shadow·인-샘플 평가 / 비활성=shadow_only / 신규=RL 정책 승급을 **검증게이트(DSR/PBO OOS) 경유**(인-샘플 avg_reward로 승급 금지) + 보상-게이트 지표 정합(선택).
**적용**: ① evaluate_model 승급 판정에 `candidate-backtest-gate`(OOS DSR/PBO) 연결 — avg_reward=학습 신호, 승급=검증가능 OOS. ② (선택) reward shaping을 Sharpe/DSR류와 정합. advisory(승급). 무중단(shadow). 테스트=OOS 게이트 통과 시만 승급.
**순서/의존**: SI-05·candidate-backtest-gate. 롤백=shadow 유지.

### SI-02. 승급 증거번들·감사 (ASG-SI) — 강력권장
**기존**: 승급게이트 5종(`candidate-backtest-gate`=dsr/pbo/walk_forward 컬럼 + promotion-gate JSON) · `darwin/monitoring.ex:127` approver='candidate'/approved_at 승인기제 · ADR(`trade_rationale`, B-01). → 게이트·승인·일부 증거 존재.
**Δ**: 기존=게이트·승인·게이트 JSON / 신규=**구조화 증거번들**(입력·검증지표·단일변수 delta·재현 로그·롤백계획) + **drift 탐지**(분포이동 경보) + verifier-auditor 재현.
**적용**: 승급 시 evidence_bundle(JSONB 이벤트 스토어 재사용) — 무엇을·왜·검증결과·롤백. drift=입력/성과 분포이동 모니터(advisory 경보). advisory(증거 미충족=승급 차단). 무중단(메타 로그). 테스트=번들 완전성·drift 경보.
**순서/의존**: SI-01·SI-05. 롤백=번들 생략.

### SI-03. 루프닫기 브레이크 페달 — 강력권장 [상당부분 기구현]
**기존(강함)**: darwin `apply.ex` handle_cast=verified→applied 전이(**verify 통과분만**)·효과 링크(commit_sha)·**적용후 측정 24h/7d/30d**(Measure.schedule). `rollback_scheduler.ex`=24h 측정→**자동 롤백 + `Darwin.V2.Lead.activate_kill_switch()`(:138)** + snapshot 기반 + log_rollback_to_db. `supervisor.ex`=RollbackScheduler·ShadowRunner/ShadowCompare. ESPL=shadow 세대 저장(operational 아님). → **브레이크 페달 상당 기구현**.
**Δ**: 기존=verified 게이트·24h 자동롤백·kill-switch 연동·shadow·승인 / 신규=**단일변수 명시 enforcement** + **경계 분류**(자본/운영 영향=적용 前 마스터, 24h 롤백 後 아님) + snapshot 복원 검증.
**적용**: ① 적용 payload에 single_var 검증(1 cycle=1 변수). ② 영향도 분류 — luna live·스카 자본/운영 영향=**경계**(적용 前 마스터). 그 외 advisory(24h 자동롤백 신뢰). ③ snapshot 복원 스모크. **경계**(자본/운영). 무중단(기존 강화). 테스트=단일변수·경계 차단·롤백 복원.
**순서/의존**: kill-switch(기구현). 롤백=기존 유지.

### SI-04. 그룹 상대 변이 (GRPO식) — 권장
**기존**: `finrl-x/layer3-strategy-evolution.py` — `fetch_underperforming_strategies`(:51)→`generate_mutation`(:86, 점수대별 regime_filter/confidence_tighten/tp_sl_adjust, **후보 1개씩**)→`validate_mutation_in_shadow`(:132, trend≤0 or exp_improvement>0.12)→strategy_mutation_events. → **변이·shadow 검증 존재, 그룹 상대 비교 없음**.
**Δ**: 기존=후보별 단일 변이·shadow 검증 / 신규=**N개 변이 동시 생성→shadow 그룹 상대 비교→상대 우위 선택**(GRPO advantage).
**적용**: generate_mutation을 N-변이로 확장 + 그룹 shadow 백테스트 → 상대 순위(그룹 평균 대비 advantage) 선택. SI-01 검증가능 보상으로 채점. advisory(shadow). 무중단(shadow). 테스트=그룹 생성·상대 선택.
**순서/의존**: SI-01. 롤백=단일 변이로.

### SI-05. 정직한 측정 게이트 — 권장 [상당부분 기구현]
**기존**: `candidate-backtest-gate.ts` = dsr·pbo·walk_forward_sharpe·sharpe_oos_deflated 컬럼 + `quant/monte-carlo`·`stress-test`(shadow). → **OOS/walk-forward/MC/stress 기구현**.
**Δ**: 기존=OOS·walk-forward·DSR·PBO·MC·stress / 신규=캘리브레이션(Brier·reliability)·벤치마크(buy-hold/random RST) = **루나 B-16/B-18과 동일**.
**적용**: B-16(캘리브레이션)·B-18(RST/PBO 게이트 배선)와 **통합**(중복 아님, 루나 보강과 공유). advisory(승급). 무중단(shadow). 테스트=B-16/B-18 참조.
**순서/의존**: 루나 B-16/B-18 합류. 롤백=shadow.

### SI-06. 자동 1차 리뷰 (병목 해소) — 권장
**기존**: GitHub Actions CI(lint/type/smart-restart) · 3역할(메티 독립검증) · refactor-cycle-runner(타입체크). → CI·인간리뷰 존재, **LLM 버그/보안 사전리뷰 게이트 부분**.
**Δ**: 기존=CI 정적검사·메티 수동리뷰 / 신규=**머지 前 자동 리뷰 게이트**(버그/보안/계약 위반, Anthropic Claude 리뷰어 패턴) → 메티는 경계 판단 집중.
**적용**: CI에 자동 리뷰 단계(diff→체크리스트 평가) → advisory 코멘트(차단 아님). 메티 검증과 중복 아닌 1차 필터. advisory. 무중단(CI 추가). 테스트=리뷰 산출·오탐율.
**순서/의존**: 독립. 롤백=단계 제거.

### SI-07. 판단 체크포인트 명문화 — 권장 [거버넌스/설계]
**기존**: 회의실(LUNA_MEETING_ROOM v0.3)·다이얼(C1)·3역할. → 인간 판단 지점 일부 존재.
**Δ**: 신규(문서)=**방향설정·레짐선택·중단판단=마스터/회의, 실행=자율** 명문 체크포인트(Anthropic 실행/판단 분리).
**적용**: DESIGN에 판단 체크포인트 표(결정별 마스터·회의·자율 구분). 코드 아닌 거버넌스. 무중단. 테스트=문서 정합.
**순서/의존**: 회의실. 롤백=없음.

### SI-08. 오류 피드백 RAG 루프 — 권장 [부분 기구현]
**기존**: luna `reflexion-engine.ts`=checkAvoidPatterns/getAllAvoidPatterns(**회피패턴 존재**)·`failed-signal-reflexion(-trigger)`·pgvector RAG. sigma `reflexion.ex`=reflect(얇음). → 회피패턴(luna)·RAG 존재, **통합 taxonomy·sigma 분류 부분**.
**Δ**: 기존=luna 회피패턴·RAG·failed-signal / 신규=**통합 오류 taxonomy** + sigma 분류 → **교차팀 RAG 회피**(다음 cycle 회수) + 재발 차단 게이트.
**적용**: 오류 이벤트 표준 스키마(taxonomy)→sigma 분류→pgvector 색인→다음 cycle RAG 회피 조회→게이트. luna 회피패턴 재사용·확장. advisory(회피 권고). 무중단(확장). 테스트=분류·회수·재발 차단.
**순서/의존**: SI-02 연계. 롤백=luna 단독.

---
## ✅ 정밀 검토 종료 — SI-01~08
- **진짜 신규(소수)**: 그룹상대변이(SI-04)·증거번들+drift(SI-02)·단일변수 enforcement+경계분류(SI-03)·캘리브레이션/RST(SI-05=B-16/18)·자동 리뷰 게이트(SI-06)·통합 오류 taxonomy(SI-08).
- **활성화/정렬**: RL 승급 OOS 게이트 경유(SI-01).
- **확장**: 회피패턴(SI-08)·승인기제(SI-02).
- **기구현(강함)**: 위험조정 보상(SI-01)·verified 게이트+24h 자동롤백+kill-switch(SI-03)·OOS/walk-forward/MC/stress(SI-05).
- **거버넌스**: 판단 체크포인트(SI-07).

## 우선순위 (안전 먼저 — Anthropic "브레이크 페달")
1. **SI-03**(단일변수·경계분류) — 가속 前 안전. 기구현 강화.
2. **SI-02**(증거번들·감사·drift) — 승급 추적.
3. **SI-01**(검증가능 보상: RL 승급 OOS 게이트).
4. SI-05(=루나 B-16/18 합류) · SI-08(오류 RAG) · SI-04(그룹변이) · SI-06(자동리뷰) · SI-07(거버넌스).

## 다음 단계
- 우선순위별 CODEX 프롬프트(SI-03→SI-02→SI-01). **단, 루나 회의실 Phase 1 CODEX와 순서 조율 필요**(둘 다 대기) — 마스터 결정.
