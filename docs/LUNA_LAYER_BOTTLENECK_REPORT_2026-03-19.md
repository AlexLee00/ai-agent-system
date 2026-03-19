# 루나 레이어별 병목 보고서

> 작성일: 2026-03-19  
> 범위: 루나팀 자동매매 시스템의 레이어별 병목 점검  
> 연계 문서: [LUNA_SYSTEM_DIAGNOSIS_2026-03-19.md](/Users/alexlee/projects/ai-agent-system/docs/LUNA_SYSTEM_DIAGNOSIS_2026-03-19.md)

---

## 1. 결론

현재 루나의 핵심 병목은 아래 순서로 정리된다.

1. **포트폴리오 판단 레이어**
2. **심볼 판단 레이어**
3. **주문 실행 / 주문 제약 레이어**
4. **리스크 승인 레이어**
5. **종목 선정 연구 레이어**

핵심 판단:
- 종목 연구는 부족하지 않다.
- 분석 비용과 판단 건수는 충분히 크다.
- 그런데 `decision -> signal -> executed` 전환이 비정상적으로 약하다.
- 특히 암호화폐는 24시간 시장인데도 `decision 1420건 / executed 0건`이므로, 현재 구조는 사용자의 목표인 `활발한 거래와 수익 파이프라인 다변화`와 맞지 않는다.

---

## 2. 레이어별 병목 평가

### 2.1 종목 선정 연구 레이어

판단: **병목 아님**

근거:
- 일간 기준 암호화폐는 `news / onchain / sentiment / ta_mtf`가 모두 `89건`씩 수행된다.
- 주간 기준 암호화폐 분석 분포도 충분히 크다.
  - `news 1797건`
  - `onchain 1462건`
  - `sentiment 1796건`
  - `ta_mtf 1861건`
- 주간 비용은 `6,724,240 tokens / $6.7981`로 높다.

해석:
- 현재 문제는 “암호화폐/국내장/해외장에서 후보를 못 찾는다”가 아니다.
- 오히려 연구량 대비 실행 전환이 약한 것이 핵심이다.

### 2.2 심볼 판단 레이어

판단: **강한 병목 후보**

근거:
- 암호화폐 분석가 분포는 강하게 엇갈린다.
  - `onchain`은 BUY 성향이 강함
  - `news`, `sentiment`, `ta_mtf`는 HOLD 비중이 큼
- 특히 `ta_mtf`는
  - 일간 `89건 전부 HOLD`
  - 주간 `1861건 중 HOLD 1836`

해석:
- 특정 분석가의 보수성이 전체 심볼 판단을 강하게 누를 가능성이 있다.
- 특히 `ta_mtf`가 실질적으로 “안전장치”가 아니라 “HOLD 고정 레이어”로 작동하는지 확인해야 한다.

### 2.3 포트폴리오 판단 레이어

판단: **가장 유력한 핵심 병목**

근거:
- 일간 퍼널:
  - 암호화폐 `decision 89건 / executed 0건 / weak 0 / risk 0`
  - 해외장 `decision 90건 / executed 0건 / weak 0 / risk 0`
- 주간 퍼널:
  - 암호화폐 `decision 1420건 / executed 0건`
  - 국내장 `decision 323건 / executed 21건`
  - 해외장 `decision 432건 / executed 5건`
- `weakSignalSkipped = 0`, `riskRejected = 0`이 반복된다.

해석:
- 현재 병목은 confidence 미달이나 risk reject가 아니라, 그 앞단에서 BUY/SELL이 충분히 남지 않는 구조일 가능성이 높다.
- [luna.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/luna.js)의 `getPortfolioDecision()`가 실질적으로 HOLD 중심으로 수렴하는지 확인이 필요하다.

### 2.4 리스크 승인 레이어

판단: **주병목은 아님, 단 부분 예외 존재**

근거:
- 퍼널 메트릭상 `riskRejected = 0`
- 다만 저장된 일부 신호에서는 `nemesis_error`가 있다.

해석:
- Nemesis가 현재 거래 부재의 주원인이라고 보기는 어렵다.
- 다만 예외 처리 안정성은 별도로 손봐야 한다.

### 2.5 주문 실행 / 주문 제약 레이어

판단: **시장별 부분 병목**

근거:
- 국내장:
  - `min_order_notional`
- 과거/누적 실패:
  - `max_order_notional`
  - `legacy_order_rejected`
  - `legacy_executor_failed`
  - `nemesis_error`

해석:
- 실행 레이어도 문제가 있다.
- 다만 현재 전체 구조에서 가장 앞선 병목은 아니며, decision 레이어 개선 이후 다시 봐야 한다.

---

## 3. 시장별 병목 해석

### 3.1 암호화폐

판단: **구조적 이상**

근거:
- 24시간 시장
- 연구량 충분
- 일간/주간 모두 `executed 0`
- `weak 0`, `risk 0`

해석:
- “장이 닫혀서 거래가 없음”으로 설명할 수 없다.
- 바이낸스 기준 목표와 가장 크게 어긋난다.
- 현재 루나의 crypto decision 체계는 `활발한 거래`보다 `HOLD 유지`에 더 치우쳐 있을 가능성이 높다.

### 3.2 국내장

판단: **부분 병목**

근거:
- 주간 `executed 21건`
- 그러나 최근 저장 신호 실패는 `min_order_notional`

해석:
- 완전히 죽은 구조는 아니다.
- 다만 주문 금액 정책과 계좌 규모/전략 규모가 안 맞을 가능성이 있다.

### 3.3 해외장

판단: **부분 병목 + 미결 포지션 편중**

근거:
- 주간 `executed 5건`
- 미결 포지션 `4개`가 모두 해외장

해석:
- 실행은 되지만 활발하다고 보기 어렵다.
- 포트폴리오 회전율과 종료 기준 쪽 점검이 필요하다.

---

## 4. 부분 보완으로 해결 가능한 문제와 어려운 문제

### 부분 보완으로 해결 가능성이 높은 것

- `ta_mtf`의 과도한 HOLD 편향 점검
- crypto `getPortfolioDecision()` 프롬프트 조정
- 국내장 `min_order_notional` 정책 재조정
- `nemesis_error`, `legacy_executor_failed` 예외 안정화

### 부분 보완만으로 해결이 어려울 가능성이 높은 것

- 연구량 대비 실행 전환율이 전반적으로 매우 낮은 구조
- 시장별 목표가 다른데도 decision 철학이 하나로 묶여 있는 구조
- 바이낸스 `활발한 거래` 목표와 현재 `보수적 포트폴리오 판단`의 방향 불일치

---

## 5. 1차 우선순위

### 1순위

- crypto `portfolio decision`의 실제 BUY/SELL/HOLD 분포 확정
- `getPortfolioDecision()` 프롬프트와 결과 대조

### 2순위

- `ta_mtf` HOLD 편향 점검
- 국내장 `min_order_notional` 정책 검토

### 3순위

- `nemesis_error`, `legacy_executor_failed` 등 예외 안정화
- 해외장 미결 포지션 관리 기준 재검토

---

## 6. 다음 단계

1. crypto `portfolio decision`의 action 분포를 실제 새 런 기준으로 수집
2. `getPortfolioDecision()` 프롬프트, `ta_mtf` HOLD 편향, crypto fast-path를 함께 비교
3. 그 결과로
   - 부분 보완안
   - 시장별 전략 분리안
   - 최소 재설계안
   중 하나를 선택
