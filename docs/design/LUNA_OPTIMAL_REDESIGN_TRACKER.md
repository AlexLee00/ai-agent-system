# 루나 최적 재설계 — 구현 추적 (TRACKER)

> v1.0 (2026-06-13) · 작성: 메티 · SSOT=LUNA_OPTIMAL_REDESIGN.md(**v1.3**) · 회의실=MEETING_ROOM_DESIGN(v0.7) · 입력=LUNA_LOGIC_REANALYSIS.md
> **우산 관계**: 본 트래커가 루나 로직 재설계의 상위 추적. 회의실(WS-A~E·G·Q)은 LUNA_MEETING_ROOM_TRACKER 유지(=C11 트랙). 기존 WS 중 재설계와 겹치는 항목은 아래 매핑대로 **본 트래커로 합류**(이중 추적 금지).
> 원칙: 무중단(PROTECTED·crypto LIVE·스카) · shadow→L4→L5 표준 경로(C15) · 검증 통과분만 승격 · 마스터=게이트.

## 기존 WS 매핑 (MEETING_ROOM_TRACKER v0.4 → 재설계)
| 기존 WS | 재설계 합류처 | 처리 |
|---|---|---|
| WS-R 알파팩터(Phase 0) | C12 예측엔진 + C5 스코어 입력 | **합류**(QuantaAlpha 궤적 진화 반영, CODEX_LUNA_ALPHA_FACTOR 갱신 후 진행) |
| WS-J 레짐 정밀화 | C2 레짐 엔진 | 합류(HMM core 승격 + 전이행렬) |
| WS-K 검증 활성화 | C7 검증 파이프라인 | 합류(+permutation 2종·point-in-time·OOS 보존 추가) |
| WS-F CPCV·리더보드 | C7 | 합류 |
| WS-N 수급 활성화 | C1 한국 게이트 신호 + C14 소스 | 합류 |
| WS-O 출구·사이징 | C3 트레일 + G5 사이징 + G7 래더 | 합류 |
| WS-L 자기개선·ADR | C8 피드백 + 0-b 루프 | 합류 |
| WS-H 학습·메모리 | C8(부분) | 합류(temporal/CVRF는 P3) |
| WS-I 리스크 훅(HWM·회로차단기) | 독립 유지(B-13) | **병행**(재설계 무관 유효 — Phase 2 그대로) |
| WS-M 스킬 · WS-P 비용 | 직교 | 병행 유지 |
| WS-A~E·G·Q 회의실 | C11 | **MEETING_ROOM_TRACKER에서 계속**(이벤트 트리거만 본 트래커 P2) |

## P0 — ✅ 전체 완료 (구현=코덱스, 검증=메티 2026-06-17, 커밋 687ece025)
> 메티 독립 검증: tsc 0 · review-hint PASS · closeout 24/24 재실행 · 코드 스팟(상수·invalidation 가드) · 감사 보고서 2건 판정. 잔여: 타입 전용 3파일(a2a/skills/*-shadow.ts) 미커밋 — 마스터 커밋 대상.
> 설계 확정(2026-06-14): G0=70/40·60% / C3 초기값 승인 / 리밋 상한 30 / Stage A=4주·30신호·E우월 / ablation=P3.
- **P0-1** reviewHint 소표본 교정 — `team/luna.ts:276` `closedTrades<3`→30 상향+**델타 절반**(확정 ④) · 코덱스 · 검증: 단위(경계값)+기존 흐름 무변 — ✅ 완료(2026-06-17 메티 검증: 상수 4종·스모크 PASS 재실행)
- **P0-2** robust selection ON — `backtest-vectorbt.py:676,750` `LUNA_BT_ROBUST_SELECTION_ENABLED=true`(launchd/env) · 코덱스 · 검증: 스모크에서 robust 합의 선택 확인 — ✅ 완료
- **P0-3** point-in-time 실측·기록 — 백테스트 메타에 `universe_asof` 기록 + discovery 선정 시점 로깅(전면 교정은 P2/C7) · 코덱스 · 검증: 메타 필드 존재 — ✅ 완료
- **P0-4** 1-bar shift 감사 — `.shift(1)` 기존재 확인됨(180·209·222), 잔여=체결가(다음 봉 시가?)·비용 반영 감사 보고서 · 코덱스(감사)→메티(판정) — ✅ 완료
- **P0-6 [v1.2]** 제약 경로 감사(코드 변경 없음) — 루나 LLM 에이전트가 자기 제약(runtime-config·env·plist·order_rules)을 런타임 수정 가능한 경로 실측 → 보고서(`docs/codex/P0_6_CONSTRAINT_AUDIT.md`) · 코덱스(감사)→메티(판정) — ✅ 완료
- **P0-5** 매도 후 자본 재평가 훅(✅) — `position-closeout-engine.ts` `finalizeCloseout`(296~)에서 capitalSnapshot 무효화→재계산(capital-manager buyable 재산출) · 코덱스 · 검증: 매도→같은 사이클 buyable 갱신(하드) — ✅ 완료

## P1 — 코어 골격 + 제안 인프라 [shadow]
- **P1-1** C15 레지스트리+제안서 생성기+**C17 파라미터 스토어**(`luna_parameter_store`·governance 통합·break-glass[v1.3]) — ✅ **완료(2026-06-11 Codex 검증)**: 테이블 2종 적용(registry 23 active·param seed 7·append-only 트리거)·스토어 모듈(immutable 강제·env 폴백)·평가기(readyForPromotion 게이트)·가드 스모크·command-policy·스모크 ROLLBACK 전환(신규 `smoke.*` 누적 0). 경미 후속: 메티 독립 검증 — shadow 23종 시드 등록(C15-b 표), 표준 경로(shadow→L4→L5), 일/주간 회의 통합, 텔레그램 제안 3종 · 재사용: hybrid-promotion-gate·rollback_scheduler — 대기
- **P1-2** C1 시장 배치 게이트(3시장 신호 합성→full/reduced/halt, 이력 로깅) — 대기
- **P1-3** C2 레짐 승격(HMM shadow→core 후보, 확률 벡터+전이 경보) · 의존: P1-1(C15 등록) — 대기
- **P1-4** C3 전략군 2종(터틀·눌림목) 룰셋 구현+shadow 신호 로깅 · stable-range 파라미터 선정(E-1) — 대기
- **P1-5** C4 사전 게이트(R:R·E·횡보·유동성) + **손실빈도 서킷 3종**(perception-first `consecutive_loss_cooldown` 일반화·승격[v1.1/1.3]) shadow — 대기
- **P1-6 [P0-4 후속]** next-bar 실행 shadow — `LUNA_BT_NEXT_BAR_EXECUTION_ENABLED=false` 기본, ON 시 신호 1봉 시프트+마지막 봉 진입 배제+현행 close 모델과 비교 스모크. 잔존: rsi_macd_reversal 현재봉 지표·close 직접 체결(P0_4_LOOKAHEAD_AUDIT 참조) — 대기
- **P1-7 [P0-6 후속]** 제약 가드 — ✅ 완료(P1-1에 포함: block 스모크+luna-autonomous-command-policy.ts, 적용 지점은 메티 검토 후) · 원명세: ①order_rules/paper_mode=block 유지 스모크 ②자율 커맨드 러너 allowlist(launchctl setenv·plist 편집·apply-runtime-config --force 차단) ③--force=마스터 런북 전용 명문화. C17 격리는 이 2건으로 1차 충족(P0-6 판정: 기존 방어 양호 — Object.freeze·confirm token·approved row·allow-list clamp 확인) — 대기
- WS-R 알파팩터(→C12)는 P1-4와 병행 가능(기존 CODEX 1번 갱신 완료 2026-06-17).

## P2 — 검증·피드백·포지션
- C7 permutation 2종+CPCV+point-in-time 전면 교정 · C8 피드백 루프(30거래 규율) · C5 스코어 융합 · C16 전략군 인식 재평가(shadow 비교→C15)+expected-fire 워치독[v1.2, 삽입점=entry-trigger-engine:534/1030, T9 테이블·보존 30일] · C11 이벤트 트리거 수시회의 · WS-I 리스크 훅.

## P3 — 자율 완성
- C9 동적 리밋 · C10 워치리스트 · C12 일원화 · C13 ablation·라우팅 · C14 오토리서치·소스 · C16 add 승격 · Stage B/C · 파라미터 스토어 전면.

## 회의실 연동 구현(재설계발 — MEETING_ROOM_TRACKER와 분담)
- 수시회의 트리거 ⑥서킷 발동(T10 안건 표준)·⑦silent miss(반복 시) — P2(C11과 함께) · ADR ID=evidence 상호 참조(P1-1 스키마에 반영) · debrief 미발화 행(G6 대조표 생성기에 포함) · 회의 결정 기한 필드+미이행 재상정(워치독 자기적용, P2).

## 무중단 체크리스트 (MEETING_ROOM_TRACKER와 공통)
- [ ] PROTECTED launchd 미중지 · crypto LIVE·스카 무중단 · 신규 plist=비-PROTECTED · shadow 우선(LIVE 영향 변경=마스터 게이트) · point-in-time/누수 차단.

## CODEX 순서 (갱신)
1. `CODEX_LUNA_P0_BATCH.md`(P0-1~5, 소형 5건 일괄 또는 분리) — **다음 작업**
2. `CODEX_LUNA_C15_REGISTRY.md`(P1-1) → 3. C1~C4(P1-2~5, 분리) → 4. ALPHA_FACTOR(갱신본) → 회의실 Phase1(병행, MEETING_ROOM_TRACKER)
