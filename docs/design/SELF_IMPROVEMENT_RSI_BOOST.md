# 자기학습 자기개선 보강안 — RSI(재귀개선) + RL/ML 기반

> 작성: 메티(Meti) · 날짜: 2026-06-08 · 상태: 분석·보강안(코드 대조 전)
> 입력: ① Anthropic "When AI builds itself"(재귀적 자기개선, 2026-06-05) ② RL/ML 딥서칭(RLVR·GRPO·GRM·ASG-SI) ③ 영상(AI뉴스 — 앤트로픽 재귀개선)
> 대상: 팀제이 **시스템 자기개선**(darwin R&D · luna 트레이딩 RL · sigma 메타최적화)
> **핵심 메시지**: 팀제이는 이미 프런티어 자기개선 아키텍처를 상당 부분 구현. 본 보강안 = 정렬 확인 + 갭 + **안전레일("브레이크 페달") 강화**.

---
## 1. 1차 출처 — Anthropic "When AI builds itself"
**재귀적 자기개선(RSI)** = AI가 사람 개입 없이 자신의 더 강한 후속을 설계·학습. "아직 도달 안 함, 불가피하지도 않음. 그러나 대비보다 빨리 올 수 있음."

- **자동화 사다리**: 사람→챗봇→코딩에이전트→자율에이전트→**루프 닫기**(Claude가 Claude를 학습). 팀제이=이미 "모델이 조율하는 에이전트 팀" 단계.
- **두 작업 유형**: 엔지니어링(코드·인프라·학습) + 리서치(어떤 실험·해석·다음 아이디어).
- **실행 vs 판단**: 실행(코드·정해진 실험)=초인적("인간은 목표만, 방법은 불필요") / **판단·연구취향**(어떤 문제·어떤 결과 신뢰·죽은 길 판단)=아직 인간 강점, 빠르게 축소.
- **메커니즘**:
  - 자동 **코드리뷰**(머지 전 Claude 리뷰어 → 과거 프로덕션 버그 ~1/3 사전 차단).
  - **미니 연구루프**(고정 목표+성공지표 → 재작성·실행·측정·반복): 3x(2025-05)→52x(2026-04) 속도개선.
  - **단일-변수 디버깅**(환경설정 하나씩 → 단일 플래그 격리 → 재현 → 수정): 2~3일 작업을 2시간.
  - **개방형 연구 end-to-end**(weak-to-strong): 가설제안·검증·병렬에이전트 공유·반복 → 97% gap 회복(800h/$18k). **"방향설정만 인간."** 단서: 프로덕션 규모 미전이·문제/루브릭은 인간 선택.
  - **판단 측정**: 다음스텝 선택 인간 초과 51%(2025-11)→64%(2026-04).
- **"perspiration 자동화"**: 점진 작업(scale→깨짐→수정→반복)은 자동화 가능. **영감·취향은 인간.** 진보=도구·자원(실험 속도/수)의 함수.
- ⚠️ **안전(이 글의 본질=경고)**: "후속을 스스로 만들 수 있다면 **보안·감시·행동형성이 훨씬 더 중요**." 속도조절·일시중단 옵션 + 정렬연구. **"브레이크 페달"**(Cold War 군축 비유). **인간 리뷰가 병목** 가능. 메트릭은 내부·자기이해(독립감사 부재)·S-curve 가능.

→ **팀제이 시사점**: 자기개선을 추구하되 **(a) 영감·방향·취향은 마스터** (b) **실행 루프는 자율** (c) **반드시 안전레일(경계)로 한계** — kill-switch·검증게이트·단일변수·롤백.

---
## 2. RL/ML 딥서칭 — 학습 메커니즘
- **RLHF**(2022, InstructGPT): 인간선호→보상모델→정책. 한계=인간 루프 비용.
- **RLVR**(2025, DeepSeek-R1): **검증가능 보상** — 환경이 직접 신호(코드=컴파일 pass/fail, 수학=정답매칭, 0/1). 인간 보상모델 불필요. 옵티마이저 **GRPO**(critic-free, PPO 인프라 제거).
  → **트레이딩 매핑**: 백테스트 게이트 지표(DSR/PBO/Sharpe/MaxDD)=**검증가능 보상**. raw PnL보다 reward-hacking 내성.
- **GRPO**(Group Relative Policy Optimization): 여러 후보를 **그룹 상대 비교**로 우위 산정. 안정성·credit assignment↑.
  → **매핑**: 전략 변이 **그룹 동시 백테스트→상대 우위** 선택(darwin/finrl-x).
- **GRM**(생성형 보상모델): 규칙이 경직된 개방도메인용 LLM 보상모델, 정책과 **공진화**.
  → **매핑**: `self-rewarding-engine` · `trade-quality-evaluator`(LLM judge).
- **에이전트 자기개선**: Reflexion(언어적 RL, Shinn2023)·RLTF(유닛테스트 피드백)·StepCoder(컴파일러 피드백)·process reward modeling.
  → **매핑**: 3층 reflexion(이미 구현).
- **ASG-SI**(Audited Skill-Graph Self-Improvement, arXiv 2512.23760) ★핵심:
  - 자기개선 = **검증기 증거로 승급 게이트되는 방향성 스킬그래프**.
  - 검증가능 **분해 보상**(도구사용 정확성·결과 타당성·스킬 재사용·합성 무결성) + **경험 합성**(스트레스 테스트·커리큘럼) + **연속 메모리 제어**.
  - 중심 메커니즘 = **verifier-auditor**: 후보 스킬을 **재현(replay)** → **최소충분 증거번들** 생성 → 승급 결정. reward hacking·분포이동·추적불가 drift 방어.
  → **매핑**: 승급게이트 5종 + `skills/luna` + ADR(B-01) 증거.

---
## 3. 팀제이 기존 자기개선 자산 — 프런티어 정렬 (코드 실측)
| 프런티어 개념 | 팀제이 자산 | 상태 |
|---|---|---|
| 미니 연구루프 / 개방형 연구 | **darwin V2 cycle**: discover→hypothesize→plan→implement→measure→verify→evaluate→apply→learn(+`skill/learn_from_cycle`) | 구현 |
| 언어적 RL(Reflexion) | luna `reflexion/{l1_immediate,l2_daily,l3_weekly}` · `reflexion-engine` · `meta-neural-reflexion`(A2A+shadow) · sigma/darwin `reflexion.ex` | 구현(시스템 전역) |
| RL(PPO) | `python/rl/`: `train-luna-ppo` · `luna_trading_env` · `weekly-retrain` · `rl_runner` · `prepare-training-data` | 구현 |
| 진화 전략 | `finrl-x` 4층: market-env · agent-pool · **strategy-evolution** · perf-opt | 구현 |
| 검증기-게이트 승급(ASG-SI) | `candidate-backtest-gate`(DSR/PBO/walk-forward) · korea-data · hybrid · paper · phase-a `promotion-gate` | 구현(shadow) |
| 생성형 보상모델(GRM) | `luna-self-rewarding-engine`(calcSelfReward) · `trade-quality-evaluator`(LLM judge) | 구현 |
| 스킬그래프 성장 | `posttrade-skill-extractor` · `skills/luna/*.skill.md` · `shadow-auto-promote` | 구현 |
| 자동 코드리뷰 | 3역할(메티 독립검증: node --check·테스트·OPS 재현) | 프로세스 |
| 오류 회피 학습 | sigma 분류 → RAG 회피 → 재발 차단 게이트 | 구현 |

→ **결론**: 팀제이는 Anthropic RSI + RL 문헌이 기술하는 자기개선 구조(연구루프·언어적 RL·검증기 승급·진화·GRM)를 **이미 상당 부분 보유**. 부족분은 "더 만들기"보다 **정렬·감사·안전레일**.

---
## 4. 갭 분석 — 프런티어 대비
- **G1. 검증가능 보상 정렬(RLVR)**: RL/변이 보상이 raw PnL이면 reward hacking·과적합 위험. → 보상=**검증게이트 통과 risk-adjusted**(DSR≥기준·MaxDD≤기준)로 정렬.
- **G2. 그룹 상대 우위(GRPO)**: 현 PPO 단일 정책. → 변이를 **그룹 동시 평가→상대 우위** 형식화(분산↓·credit assignment↑).
- **G3. 감사·증거번들(ASG-SI)**: 승급게이트는 있으나 **verifier-auditor 재현 + 증거번들** 부재 → drift·reward-hacking 추적 곤란. → 승급마다 증거번들(입력·검증지표·단일변수 delta·롤백계획) + **drift 탐지**.
- **G4. 루프닫기 안전("브레이크 페달")**: darwin `apply.ex` 자동 적용 경로. → 적용 = **verify/proof-r 통과분 + 단일변수 + 자동롤백 + kill-switch 연동**.
- **G5. 판단 vs 실행 경계**: 실행 자동화 OK, **판단(방향·레짐·중단)은 마스터**(Anthropic: "방향설정만 인간"). → 인간 판단 체크포인트 명문화.
- **G6. 정직한 측정**: 메트릭 자기이해 위험(Anthropic 자기경고). → **OOS·walk-forward·벤치마크(buy-hold/random RST)·캘리브레이션** 필수. metric 해킹 방지.
- **G7. 인간 리뷰 병목**: 메티 리뷰가 병목 가능(Anthropic 경고). → **자동 1차 리뷰 게이트**(Claude 리뷰어 패턴) + 메티는 경계 판단 집중.

---
## 5. 보강안 — 안전레일 동반 자기개선 (SI-01 ~ SI-08)

### 강력권장
- **SI-01. 검증가능 보상 정렬(RLVR)**: RL(`train-luna-ppo`)·darwin 변이 보상함수 = **검증게이트 통과 risk-adjusted**(DSR/PBO·MaxDD 페널티). 근거=RLVR·과적합 방지. 안전레일: shadow 측정→마스터 게이팅. 자산: `candidate-backtest-gate`+`luna_trading_env`.
- **SI-02. 승급 증거번들·감사(ASG-SI)**: 모든 자동 승급(shadow→active)에 **증거번들**(입력·검증지표·단일변수 delta·재현 로그·롤백계획) + **drift 탐지**(분포이동 경보). 근거=ASG-SI verifier-auditor. 안전레일: 증거 미충족=승급 차단(advisory). 자산: `*-promotion-gate`+ADR(B-01).
- **SI-03. 루프닫기 브레이크 페달**: darwin `apply.ex` 자동 적용 = **verify/proof-r 통과 + 단일변수 + 자동롤백 + kill-switch 연동**. 근거=Anthropic 안전("보안·감시·형성 더 중요"). 안전레일: **경계**(자본/운영 영향 시 마스터). 자산: darwin `cycle/{verify,evaluate,apply}`.

### 권장
- **SI-04. 그룹 상대 변이(GRPO식)**: darwin hypothesize → **여러 변이 동시 측정 → 그룹 상대 우위** 선택. 근거=GRPO 안정성. 자산: `finrl-x` layer3 + darwin `measure`.
- **SI-05. 정직한 측정 게이트**: 승급 전 **OOS/walk-forward/벤치마크/캘리브레이션** 필수(자기이해 방지). 근거=Anthropic 메트릭 경고+RLVR 검증. 자산: `candidate-backtest-gate`+(보강 B-16).
- **SI-06. 자동 1차 리뷰(병목 해소)**: 코덱스 산출 **자동 리뷰 게이트**(버그/보안/계약 위반) → 메티는 경계 판단만. 근거=Anthropic 리뷰 병목+자동리뷰. 자산: 3역할 + CI.
- **SI-07. 판단 체크포인트 명문화**: 방향설정·레짐선택·중단판단=**마스터/회의**, 실행=자율. 근거=Anthropic 실행/판단 분리. 자산: 회의실(LUNA_MEETING_ROOM) + 다이얼.
- **SI-08. 오류 피드백 RAG 루프 강화**: 오류 캡처→sigma 분류→다음 cycle **RAG 회피**→재발 차단 게이트(시간이 갈수록 오류↓). 근거=경험 합성(ASG-SI)+reflexion. 자산: sigma reflexion + pgvector.

### 참고
- 학습 안정성 라이브러리(GRPO/process-reward 구현) 차용은 선택. **local 우선**(MLX). 양자화·동시실행 주의.

---
## 6. 안전 원칙 — "브레이크 페달" (Anthropic 경고 구현)
1. **경계 안에서만 자기개선**: 자본/운영 영향=마스터 · kill-switch · 검증게이트 후 승급 · 단일변수 · 자동롤백.
2. **측정 정직성**: OOS·벤치마크·메티 독립검증. **metric 해킹 금지**(reward=검증가능 지표).
3. **인간 판단 보존**: 방향·취향·중단은 마스터. 실행만 자율.
4. **점진·가역**: 한 번에 하나(단일변수), 항상 롤백 가능.
→ Anthropic "보안·감시·행동형성이 더 중요"를 **가드 철학의 경계**로 구현(LUNA_MEETING_ROOM §3와 정합).

---
## 7. 다음 단계
- SI-01~08 **코드 대조 정밀 검토**(각 기존자산 file:line — darwin cycle·train-luna-ppo·promotion-gate) → 적용안(advisory vs 경계·무중단·테스트) → CODEX 프롬프트.
- 우선순위: SI-03(안전)·SI-02(감사)·SI-01(보상) 먼저 — 자기개선 가속 전 **안전레일부터**.
