# 루나팀 — 진입 트리거 정교화 + 발화 레이어 통합 설계 (ET 트랙)

> v0.1 (2026-06-18) · 작성: 메티 · 상위 SSOT=LUNA_OPTIMAL_REDESIGN.md(v1.3) C3·C16·T9 · 본서=entry-trigger-engine 재사용 연결 증분 설계
> 근거: 마스터 지시(B 트랙 — 진입 트리거 정교화) + entry-trigger-engine·전략군·shadow 게이팅 실측
> 원칙(불변): 무중단(PROTECTED·crypto LIVE·스카) · **전부 shadow — liveFireEnabled=false 강제로 실발화 0** · 마스터=게이트 · 과거 기록 불변

---

## 0. 배경 — "신호는 있으나 발화가 없다"

재설계(P0~P1)는 **신호 생성까지** 완성: 30분 러너 G0 게이트→G1 레짐→G2/G3 전략군(터틀/테스타 **기본 룰**)→G4 프리플라이트→서킷. 전부 shadow.

**미연결 2가지**:
1. **C3 정교 트리거**: 전략군 진입 룰의 "리테스트 확인"(range)·"래더 분할매수"·MTF 동의는 설계상 `entry-trigger-engine` 재사용 예정이나 **현재 미연결**(30분 러너는 기본 돌파/눌림만).
2. **발화 레이어**: "신호 → 실제 발화(주문)" 단계가 재설계 스택에 없음. entry-trigger-engine이 그 자산(worker만 retired, 엔진 보존).

본 트랙 = 이 둘을 shadow로 연결 + C16 expected-fire 워치독(발화 누락 감지).

## 1. entry-trigger-engine 실측 (연결 대상)

### 1-1. 구조
- 진입점: `evaluateEntryTriggers(candidates, context)` — candidates는 `{action:'BUY', symbol, confidence}`. ACTIONS.BUY만 처리. armed/fired/blocked 상태머신.
- `buildEntryTriggerFireReadiness(candidate, context)` — MTF 동의·정렬 점수·기술 텔레메트리 기반 발화 준비도.
- 고유 기능: 트리거 품질 게이트·**라이브 리스크 게이트**·**래더**(`evaluateActiveEntryTriggersAgainstMarketEvents`)·최근 매수 신호 트리거 갱신·리테스트 대기(TTL).
- 자체 DB 3종: `entry_triggers`(트리거 상태)·`discovery_source_metrics`·`unmapped_news_events`.

### 1-2. 🔑 shadow 게이팅 (안전의 핵심 — 실측 확인)
```
shouldAllowLiveEntryFire(): entryTriggerEnabled && liveFireEnabled && (autonomous? fireInAutonomous : ...) — liveFireEnabled=false면 무조건 false
shouldEntryTriggerMutate(): entryTriggerEnabled && (!shadow || mutateInShadow)
```
→ **`liveFireEnabled=false` + `shadow=true`로 실발화 0 보장.** armed/관찰은 하되 fire(주문)는 차단. 기존 내장 안전장치 재사용.

## 2. 연결 전략 — 통째 vs 추출 (트레이드오프)

| 접근 | 장점 | 단점 | 판정 |
|---|---|---|---|
| **A. 통째 연결**(entryTriggerEnabled=true·liveFireEnabled=false) | 빠름·기존 로직 전부 가용(리테스트/래더/MTF/리스크게이트) | 구세대 복잡성 전부 가동(뉴스이벤트·자체DB)·재설계 정신과 거리 | 1단계 관찰용 |
| **B. 로직 추출**(리테스트/래더만 전략군에 통합) | 깔끔·신세대 스택 일관 | 추출 작업·로직 재구현 위험 | 2단계 정리 |

**권고: 단계적** — ET-A에서 **통째 연결(shadow)로 관찰** → 리테스트/래더가 실제 유용한지 데이터 확인 → ET-B에서 **유용 로직만 신세대로 정리**. 처음부터 추출하면 무엇이 유용한지 모른 채 재구현 위험.

## 3. shadow 발화 레이어 정의

거래가 shadow이므로 "발화"=실주문 아님. **"발화 후보"(would-fire) 기록**:
- 전략군 entry 신호 → 어댑터 → entry-trigger armed → readiness 충족 → **`would_fire` 기록**(주문 안 함·placed:false, 토스 paper-mirror와 동일 철학).
- LIVE 전환 시(미래·마스터 승인) liveFireEnabled=true로 실발화 — 그 전까지 would-fire 데이터만 축적.

## 4. C16 expected-fire 워치독 (발화 누락)

- **정의**: 전략군 신호가 발화 조건 충족(would-fire 기록)인데 → N분 내 매칭 실행(다음 단계/주문) 없음 = **silent miss**. 또는 게이트·레짐 우호인데 신호 자체 0(조건 근접 미달).
- **삽입점 보정**: 설계 199행은 entry-trigger-engine(534/1030) 명시 → **ET-A 연결 후 그 지점 유효**. 연결 전이면 30분 러너 전략군→프리플라이트 흐름.
- T9: 테이블 1개(트리거ID·조건 스냅샷·기대 액션·매칭·시각)·30일 보존·**debrief plan vs actual 미발화 편차 자동 등재**·수시회의 트리거⑦.
- 근거: V-P 실사고(서버 트리거 미발화로 딥 매수 누락).

## 5. 구현 분할 (ET-A~D)

| 분할 | 범위 | 검증 |
|---|---|---|
| **ET-A** | 전략군 신호→entry-trigger candidate 어댑터 + **통째 shadow 연결**(entryTriggerEnabled=true·liveFireEnabled=false 강제) + 30분 러너에 trigger 평가 단계(shadow) | armed 동작·**fire 0 단언**·실발화 경로 차단·기존 신호 무영향 |
| **ET-B** | 리테스트/래더 트리거가 전략군 룰과 정합되는지 관찰 후 정리(range 리테스트·터틀 피라미딩 유닛). would-fire 기록 | 리테스트/래더 판정·would_fire placed:false |
| **ET-C** | **C16 expected-fire 워치독**(would-fire vs 매칭) + debrief 미발화 편차 등재 + 수시회의 트리거⑦. 테이블 1개·30일 | silent miss 감지·debrief 등재·30일 정리 |
| **ET-D** | C15 등록(전략군 룰 재평가 vs 기본 shadow 비교) + 승급 기준 | 레지스트리 등록·승급 제안 |

- ET-A~C 전부 shadow(실발화 0). LIVE 발화는 별도(마스터 승인·liveFireEnabled).

## 6. 안전 체크리스트
- [ ] liveFireEnabled=false 강제(전 단계) · shouldAllowLiveEntryFire()=false 단언 · fire/주문 경로 0
- [ ] PROTECTED 무중단 · crypto LIVE·스카 무중단 · 신규 plist 최소(30분 러너 통합 우선)
- [ ] entry-trigger 자체 DB(entry_triggers 등) 활성화가 기존 데이터·러너 무영향
- [ ] would-fire는 placed:false(토스 paper-mirror 패턴) · 과거 기록 불변
