# 루나 Shadow 계층 전수 인벤토리 + 걷어내기 방법론

> 작성: 메티 · 2026-06-26 · 상태: 분석 (read-only)
> 발견 계기: 마스터 "shadow가 계속 쌓여서 시스템이 제 성능을 못 내는 것 같다. 계층을 모두 분석하고 가장 하위부터 적용 유무 검토 후 하나씩 걷어내자"
> 범위: bots/investment 전체 shadow 플래그 약 48종

## 핵심 문제 — Shadow에는 2종류가 있다

shadow 플래그를 분석하면 **본질이 다른 두 종류**로 갈린다:

### (A) Kill-switch 형 — 기본 OFF, 안 쌓임
- `=true`로 명시해야 활성화. 기본은 비활성(꺼짐).
- 예: `UNIFIED_GUARD_SHADOW_ENABLED` ("기본 false = Kill Switch OFF"), `LUNA_ENTRY_TRIGGER_FIRE_IN_SHADOW`(false), `LUNA_ENTRY_TRIGGER_SHADOW_BLOCKS_BUY`(false)
- **이건 마스터가 우려하는 "쌓임"의 원인이 아님** — 꺼져 있음.

### (B) Shadow-default 형 — 기본 ON, 계속 쌓임 ★문제
- 기본이 shadow=true. 명시적 승급 전까지 영원히 shadow로 도는 evidence 수집 모드.
- 예: `LUNA_ML_PRICE_PREDICTOR_SHADOW_MODE`(true), `LUNA_KAIROS_SHADOW_MODE`(true), market-gate/circuit `shadowOnly:true`
- **이것이 "쌓여서 제 성능 못 내는" 주범** — 평가만 하고 실행/반영 안 됨.

**걷어내기 = (B)형을 하나씩 검증→승급(APPLY)하거나 폐기(REMOVE)하는 작업.** (A)형은 이미 꺼져 있어 대상 아님(단 잔존 코드 정리는 가능).

## Shadow 계층 구조 (4계층)

블래스트 반경(영향 범위)이 작을수록 하위 계층. 걷어내기는 하위(작은 위험)부터.

```
[L3] 거래 모드 (최상위 = 최대 영향, 실거래 스위치)
      trading_mode / PAPER_MODE / binance_mode / kis_mode
      └ crypto=LIVE(이미) / KIS=paper. 이건 "마지막에" 켜는 것.
   ▲
[L2] 파이프라인 단계 shadow (신호→게이트→진입→청산이 실제 DB/결정에 반영되는지)
      market-gate shadowOnly, circuit shadowOnly, entry-trigger, entry-preflight,
      strategy-exit, candidate-backtest, korea-data-signal, phase-a-log
   ▲
[L1] 기능/모델 shadow (개별 실험 기능이 evidence 수집용으로 도는 것)
      ml-predictor, factor-model, rl-policy, regime-llm, entry-llm, monte-carlo,
      meta-reflexion, dynamic-tpsl, stat-arb, regime-expansion, pattern-relaxation,
      kairos, vault-adjust, predictive-evidence, community-evidence, hub-llm
   ▲ (가장 granular = 최소 블래스트 = 가장 먼저 검토)
```

**"가장 하위 계층"의 두 해석:**
- 해석1 = 가장 granular/주변부 = L1 개별 기능 (블래스트 최소) → **안전한 걷어내기 시작점**
- 해석2 = 가장 foundational = L3 거래모드 → 이건 실거래 스위치라 **마지막**에 켜야 안전
- 메티 권장: **L1(개별 기능)부터 걷어내고 L3(거래모드)를 마지막**으로. 블래스트 반경 순.

## 계층별 상세 플래그 목록

### L1 — 기능/모델 shadow (개별 실험, 최소 블래스트)
| 플래그 | 기본 | 기능 | 승급사다리 |
|---|---|---|---|
| LUNA_ML_PRICE_PREDICTOR_SHADOW_MODE | ON(B) | ML 가격예측 | 단순 on/off |
| LUNA_KAIROS_SHADOW_MODE | ON(B) | 카이로스 타이밍 | 단순 |
| LUNA_FACTOR_MODEL_SHADOW_ENABLED | ? | 팩터모델 | A2A shadow_ready |
| LUNA_RL_POLICY_SHADOW_ENABLED | ? | RL 정책 | 단순 |
| LUNA_REGIME_LLM_SHADOW_ENABLED | ? | 레짐 LLM | A2A |
| LUNA_ENTRY_LLM_SHADOW_ENABLED | ? | 진입 LLM | A2A entry-decision |
| LUNA_MONTE_CARLO_STRESS_SHADOW_ENABLED | ? | 몬테카를로 | 단순 |
| LUNA_META_REFLEXION_SHADOW_ENABLED | ? | 메타 reflexion | A2A |
| LUNA_DYNAMIC_TPSL_SHADOW_ENABLED | ? | 동적 TP/SL | A2A dynamic-tpsl |
| LUNA_STAT_ARB_SHADOW_ENABLED | ? | 통계차익 | 단순 |
| LUNA_REGIME_EXPANSION_SHADOW | ? | 레짐 확장 | 단순 |
| LUNA_PATTERN_RELAXATION_SHADOW | ? | 패턴 완화 | 단순 |
| VAULT_SHADOW_ADJUST_ENABLED | ? | vault 가중조정 | 단순 |
| LUNA_PREDICTIVE_EVIDENCE_SHADOW_MODE | ? | 예측 evidence | 단순 |
| LUNA_COMMUNITY_EVIDENCE_SHADOW_MODE | ? | 커뮤니티 evidence | 단순 |
| INVESTMENT_LLM_HUB_SHADOW | ? | Hub LLM 라우팅 | 단순 |

### L2 — 파이프라인 단계 shadow (중간 블래스트)
| 플래그 | 기본 | 기능 |
|---|---|---|
| market-gate `shadowOnly` | ON(B) | 시장게이트 신호 반영 |
| circuit `shadowOnly` | ON(B) | 서킷 잠금 반영 (방금 min_sample 개선) |
| ENTRY_PREFLIGHT_SHADOW_ENABLED (+LUNA_ 레거시) | ? | 사전게이트 |
| LUNA_ENTRY_TRIGGER_SHADOW | ? | 진입 트리거 |
| LUNA_ENTRY_TRIGGER_FIRE_IN_SHADOW | OFF(A) | shadow서 실발화 |
| LUNA_ENTRY_TRIGGER_SHADOW_BLOCKS_BUY | OFF(A) | shadow가 매수차단 |
| LUNA_STRATEGY_EXIT_SHADOW | ? | 전략 청산 |
| LUNA_CANDIDATE_BACKTEST_SHADOW_MODE | ? | 후보 백테스트 게이트(PSR) |
| KOREA_DATA_SHADOW_SIGNAL_CONFIRM | ? | ★국내 신호 확정 (domestic 직결) |
| PHASE_A_SHADOW_LOG_CONFIRM | ? | Phase A 로그 |
| UNIFIED_GUARD_SHADOW_ENABLED | OFF(A) | 통합 가드 (Kill Switch) |

### L3 — 거래 모드 (최대 블래스트, 실거래 스위치)
| 플래그 | 현재 | 기능 |
|---|---|---|
| binance_mode | LIVE | 바이낸스 실거래 (2개월 +$2,655) |
| kis_mode | paper | ★국내/해외 실거래 (꺼짐) |
| trading_mode / PAPER_MODE | mixed | 전역 모드 |
| secrets.ts 강제변환 | live→paper 안전함수 (특정 경로) |

(? = 기본값 미확인, 걷어낼 때 개별 확인 필요)

## 자동승급 시스템 (promotion ladder)

### TOSS 4단계 사다리 (promotion-stage.ts) — 정식 등록
`s0_shadow → s1_paper_mirror → s2_micro_live → s3_scaled`
- **s2/s3(실거래)는 liveTrading + 마스터 승인 필수** → 없으면 s0로 강등 (안전장치 작동 중)
- 환경변수: LUNA_TOSS_PROMOTION_STAGE, LUNA_TOSS_PROMOTION_APPROVED, LUNA_TOSS_S2_APPROVED

### luna-weight-vector.ts 상태머신 — 전략 품질 승급
`shadow_ready → shadow_tuned → shadow_evaluated → shadow_probation_with_risk_tightening → ...`
- 전략군 가중치 할당 승급. allocation_candidate_shadow_ready 등.

### A2A 스킬 dataHealth — 기능별 준비도 보고
factor-model·entry-decision·dynamic-tpsl·meta-reflexion·market-regime 등이 `shadow_ready`/`shadow_partial` 보고.
- **이게 "자동승급 등록된 것"** — 준비도를 시스템이 추적. 나머지 단순 on/off는 미등록(수동 판단 필요).

## 핵심 구분 — 등록 vs 미등록
- **등록(승급추적)**: TOSS 4단계, weight-vector 상태머신, A2A dataHealth 보고 기능들 → 시스템이 "준비됐는지" 추적 → 걷어낼 때 evidence 확인 쉬움.
- **미등록(단순 on/off)**: ml-predictor, kairos, monte-carlo, stat-arb 등 → 승급 추적 없음 → 걷어낼 때 shadow 로그/DB를 직접 봐서 validation 판단 필요.

## 걷어내기 방법론 — 플래그별 3-way 판정

각 shadow 플래그를 걷어낼 때 **KEEP / APPLY / REMOVE** 중 하나로 판정. 판정엔 evidence 필요.

### 판정 기준
- **APPLY (shadow 해제 → live 반영)**: shadow 로그가 충분히 쌓였고(표본), shadow 판단이 실거래에 유익함이 검증됨(승률·일치율·기대값 개선). 단 거래모드(L3)는 마스터 전용.
- **KEEP (shadow 유지)**: 아직 evidence 부족(표본 적음) 또는 검증 미완. 더 수집 필요.
- **REMOVE (코드/플래그 폐기)**: shadow 로그가 비었거나(미작동), 기능이 deprecated거나, 다른 것으로 대체됨. 죽은 shadow.

### 플래그별 확인 절차 (걷어낼 때마다)
1. shadow 로그/DB 테이블 조회 — 행이 쌓이나? 언제부터? 몇 건?
2. (등록형) dataHealth/promotion 상태 확인 — shadow_ready인가?
3. (미등록형) shadow 판단 vs 실제 결과 비교 — 일치율/유익성
4. 의존성 확인 — 이 shadow를 끄면 영향받는 다른 컴포넌트?
5. 판정 → APPLY면 마스터가 env/config 변경, REMOVE면 코덱스가 코드 정리

## 권장 걷어내기 순서 (블래스트 반경 순, 하위→상위)

> 원칙: 작은 위험부터. 검증된 것만 APPLY, 죽은 것 REMOVE, 미검증 KEEP. PROTECTED launchd 무중단.

**1단계 — L1 개별 기능 정리 (가장 먼저, 최소 위험)**
- 16개 L1 기능을 하나씩: 죽은 shadow REMOVE(코드 경량화), 검증된 것 APPLY, 미검증 KEEP.
- 효과: shadow 누적의 대부분 차지 → 정리하면 시스템 경량화 + 명확성. 실거래 영향 없음(개별 기능).
- 우선 후보: 로그가 빈 것(미작동) 식별 → REMOVE로 surface 축소부터.

**2단계 — L2 파이프라인 shadow (중간 위험)**
- circuit(방금 개선)·market-gate부터: min_sample 개선 효과 검증 후 shadowOnly 해제 검토.
- KOREA_DATA_SHADOW_SIGNAL_CONFIRM(국내 직결) → 국내 신호 확정 활성화 = 국내 가동의 핵심.
- entry-preflight·entry-trigger·strategy-exit 순차.
- 효과: 국내/해외 파이프라인이 실제 신호 생성·반영 시작.

**3단계 — L3 거래 모드 (마지막, 마스터 전용, 최대 위험)**
- kis_mode paper→live = 국내/해외 실거래 활성화.
- **반드시 1·2단계로 신호 생성·반영이 shadow에서 정상 검증된 후에만.**
- 손익 데이터 보정(C7-9 Phase 0) 완료 후 (오염된 데이터로 실거래 금지).
- 마스터가 단계적으로 (micro_live → scaled).

## 세션별 진행 계획 (1세션 1계층 권장)

- **이번 세션**: 인벤토리 + 방법론 (본 문서) ✅
- **다음 세션**: L1 기능 shadow 로그 전수 조회 → 죽은 것(REMOVE 후보)·검증된 것(APPLY 후보)·미검증(KEEP) 분류
- **그 다음**: L1 판정 결과로 코덱스 정리(REMOVE) + 마스터 APPLY
- **이후**: L2 파이프라인 → L3 거래모드 순

## 주의
- 실제 shadow 해제(env/config 변경)와 live 전환은 **마스터 전용**. 메티는 분석·판정·명세까지.
- REMOVE(코드 폐기)는 코덱스 구현. 메티는 명세.
- PROTECTED launchd(crypto LIVE·스카 매출) 무중단. circuit/market-gate는 PROTECTED라 신중.
- 걷어내기는 되돌릴 수 있게 1개씩 + 각 단계 검증.

## 큰 그림
마스터 직감대로 shadow가 48종 누적 — 특히 (B)형(기본 ON)이 "평가만 하고 반영 안 되는" 상태를 만들어 시스템이 제 성능을 못 냄. 해법은 계층별·블래스트순으로 하나씩 검증하며 APPLY(승급)/REMOVE(폐기)/KEEP(유지) 판정. L1(개별 기능)부터 시작해 L3(거래모드)를 마지막으로. 국내/해외 가동은 L2(파이프라인)+L3(거래모드)의 결과물이며, 그 전제는 신호 생성 복구(서킷 개선, 완료)와 데이터 보정(Phase 0).
