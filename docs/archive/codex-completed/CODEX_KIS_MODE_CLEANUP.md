# KIS 모드 정리안

## 배경

현재 투자 시스템에는 두 종류의 모드 축이 함께 존재한다.

- 실행 모드
  - `trading_mode`
  - `paper_mode`
- KIS 브로커 계좌 모드
  - `kis.paper_trading`
  - `kis_mode`

이 구조는 과거에는 의미가 있었지만, 현재는 `live인데 broker는 mock` 같은 어색한 조합을 만들 수 있다.

이번 운영 이슈:

- `한울(KIS해외) - JBLU SELL`
- `KIS API 오류 [90000000]: 모의투자에서는 해당업무가 제공되지 않습니다.`

직접 원인은 `executionMode=live` 상태에서 KIS 브로커만 `mock`으로 붙은 점이다.

## 현재 구조

코드 기준 핵심 해석:

- [`shared/secrets.js`](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/secrets.js)
  - `getTradingMode()`가 `executionMode`를 결정
  - `isKisPaper()`가 `brokerAccountMode`를 결정
- [`shared/kis-client.js`](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/kis-client.js)
  - `isKisPaper()`를 기준으로 paper/live API endpoint, TR_ID, app key를 선택
- [`team/hanul.js`](/Users/alexlee/projects/ai-agent-system/bots/investment/team/hanul.js)
  - 실행 전 리스크/주문 경로에서 `isKisPaper()` 영향 받음

즉 현재 시스템은 다음처럼 해석된다.

- `executionMode`
  - 주문 자체를 허용할지 결정
- `brokerAccountMode`
  - KIS를 mock 계좌로 붙일지 real 계좌로 붙일지 결정

## 문제점

1. 의미가 겹친다.
- `paper_mode=false`인데 `kis.paper_trading=true`면 시스템은 live처럼 행동하지만 브로커는 mock이다.

2. 운영 해석이 어렵다.
- 알림과 로그에서 "실행"처럼 보이지만 실제 체결은 안 되는 상태가 생긴다.

3. 해외장 예외가 숨어 있다.
- KIS mock은 해외 SELL 같은 일부 업무를 지원하지 않는다.
- 따라서 조합 자체가 기술적으로 불완전하다.

4. 설정 원천이 분산된다.
- `config.yaml`
- Hub `config`
- `PAPER_MODE`
- `kis.paper_trading`
- `kis_mode`

## 전수 조사 결과

레거시 영향 범위는 생각보다 넓다.

- 설정/해석
  - [`shared/secrets.js`](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/secrets.js)
- API 클라이언트
  - [`shared/kis-client.js`](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/kis-client.js)
- 실행기
  - [`team/hanul.js`](/Users/alexlee/projects/ai-agent-system/bots/investment/team/hanul.js)
  - [`team/nemesis.js`](/Users/alexlee/projects/ai-agent-system/bots/investment/team/nemesis.js)
- 리포트/스크립트
  - [`scripts/force-exit-candidate-report.js`](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/force-exit-candidate-report.js)
  - [`scripts/force-exit-runner.js`](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/force-exit-runner.js)
- 문서
  - [`SYSTEM_DESIGN.md`](/Users/alexlee/projects/ai-agent-system/bots/investment/context/SYSTEM_DESIGN.md)
  - [`TEAM_INVESTMENT_REFERENCE.md`](/Users/alexlee/projects/ai-agent-system/docs/team-indexes/TEAM_INVESTMENT_REFERENCE.md)

즉 `kis.paper_trading`은 단순 설정 하나가 아니라 현재 투자팀 모드 해석 축 일부다.

## 정리 방향

핵심 원칙:

- 운영 판단의 단일 기준은 `executionMode`
- 브로커 계좌 선택은 시장별 `brokerAccountMode`
- 레거시 입력값은 남기더라도 최종 해석 계층은 하나로 통일

권장 목표 상태:

- `trading_mode` / `paper_mode`
  - `executionMode`만 결정
- `kis_mode`
  - KIS `brokerAccountMode`만 결정
- `kis.paper_trading`
  - 제거 대상

즉 장기적으로는 아래처럼 단순화한다.

- `executionMode`
  - `paper` / `live`
- `brokerAccountMode`
  - `mock` / `real`
- KIS는 `kis_mode=inherit|paper|live`로만 제어

## 권장 마이그레이션

### 1단계: 충돌 차단

목표:
- 위험한 조합을 더 이상 조용히 허용하지 않기

할 일:
- `executionMode=live` + `brokerAccountMode=mock` 조합이면 경고 또는 명시 차단
- 해외 SELL mock 미지원은 사전 차단 유지

현재 상태:
- [`hanul.js`](/Users/alexlee/projects/ai-agent-system/bots/investment/team/hanul.js)에 해외 SELL mock 선차단 로컬 반영됨

### 2단계: 해석 통일

목표:
- `isKisPaper()`가 `kis_paper_trading`보다 `kis_mode` 중심으로 동작

할 일:
- `resolveBrokerMode()`를 KIS 기준 진실원천으로 승격
- `kis.paper_trading`은 fallback 레거시로만 취급
- 충돌 시 warning 출력

예시:
- `kis_mode=paper`면 mock
- `kis_mode=live`면 real
- `kis_mode=inherit`면 `executionMode` 상속
- `kis.paper_trading`은 구버전 config 호환시에만 읽음

### 3단계: 설정 제거

목표:
- 신규 설정에서 `kis.paper_trading` 제거

할 일:
- `config.yaml.example`에서 제거
- Hub `config` 응답에서 제거
- 문서에서 deprecated 표시 후 삭제

### 4단계: 스크립트/리포트 정리

목표:
- 리포트와 운영 명령도 새 기준만 사용

할 일:
- `force-exit-*`
- health/report류
- 운영 설명 문서

## 추천 적용 순서

1. `hanul` 선차단 커밋/푸시
2. `shared/secrets.js`에서 `isKisPaper()` 해석 우선순위 재정의
3. `config.yaml.example`와 Hub config 스키마 정리
4. 관련 스크립트/문서 정리

## 판단

이번 이슈는 주문 로직 단일 버그라기보다 모드 체계 이중화 문제다.

따라서 우선순위는 아래가 맞다.

1. 운영 오류 재발 방지
2. 모드 해석 단일화
3. 레거시 설정 제거

짧게 말하면:

- `kis.paper_trading`은 레거시다
- 지금은 살아 있지만, 더 이상 기준 축으로 두면 안 된다
- 다음 리팩터링은 `executionMode + brokerAccountMode` 두 축만 남기도록 수렴해야 한다
