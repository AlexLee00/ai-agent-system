# Scheduler Ownership Policy

## 목적

스케줄 중복으로 생기는 다음 문제를 막기 위한 운영 기준이다.

- 같은 작업이 `launchd`와 `Quantum`에서 동시에 실행됨
- UTC/KST 해석 차이로 잘못된 시각에 실행됨
- 헬스체크와 ownership 표기가 실제 운영과 어긋남

## 기본 원칙

### 1. `launchd`가 맡아야 하는 작업

다음 조건에 하나라도 해당하면 `launchd`를 canonical owner로 둔다.

- KST wall-clock 시각이 중요한 사용자 노출 작업
- macOS 로컬 환경 의존 작업
- 브라우저/Node/CLI 스크립트를 직접 실행하는 작업
- 운영자가 `launchctl`로 바로 보고 제어해야 하는 작업
- 각 팀 `bots/*/launchd/*.plist`가 이미 운영 기준인 작업

예:

- 장 시작/장 마감 알림
- 일일/주간 리포트
- prescreen, scout 같은 wall-clock 트리거
- 블로그 발행/수집 스크립트
- 클로드 dexter/speed-test 같은 주기 실행 스크립트

### 2. `Quantum`이 맡아야 하는 작업

다음 조건에 해당하면 `Quantum`을 canonical owner로 둔다.

- Elixir 내부 orchestration이 직접 호출해야 하는 작업
- UTC 기준으로 해석해도 의미가 명확한 공용 스케줄
- launchd plist가 없는 TeamJay 내부 작업
- scheduler와 app lifecycle을 같은 OTP supervision 아래에서 관리하는 편이 유리한 작업

예:

- TeamJay diagnostics/shadow report
- 향후 launchd로 분리되지 않은 내부-only 포트 작업

### 3. 한 작업에는 canonical scheduler를 하나만 둔다

- 같은 작업을 `launchd`와 `Quantum`에 동시에 등록하지 않는다.
- 호환용 래퍼/수동 실행 함수는 남길 수 있다.
- 하지만 자동 스케줄은 한쪽만 가진다.

## 구현 규칙

### launchd canonical owner

- `bots/<team>/launchd/*.plist`에 실제 주기를 둔다.
- Elixir `PortAgent`는 `schedule: nil` 또는 `:once`만 허용한다.
- Quantum `config.exs` cron에는 같은 작업을 넣지 않는다.
- `service-ownership.json`은 `owner: "launchd"`로 맞춘다.

### Quantum canonical owner

- `config :team_jay, Jay.Core.Scheduler` 또는 팀 Supervisor schedule을 사용한다.
- 같은 작업용 launchd plist는 두지 않거나 retired 처리한다.
- `service-ownership.json`은 `owner: "elixir"`로 맞춘다.

## 운영 체크리스트

스케줄을 추가/변경할 때는 아래를 같이 본다.

1. 이미 같은 label/script를 실행하는 launchd plist가 있는가
2. `config.exs` 또는 TeamJay Supervisor에 같은 작업이 있는가
3. `service-ownership.json` owner가 실제 운영과 맞는가
4. health-check/report가 canonical owner 기준으로 정상 판정하는가
5. live 프로세스 재기동 후 새 기준이 반영됐는가

## 현재 정리 방향

- 투자팀 wall-clock 스케줄: `launchd` canonical
- 블로그팀 주기 작업: `launchd` canonical
- 워커팀 주기 작업: `launchd` canonical
- 클로드팀 주기 작업: `launchd` canonical
- TeamJay diagnostics: `Quantum` canonical
- Darwin weekly cadence (`ai.darwin.weekly.autonomous`, `ai.darwin.weekly-ops-report`, `ai.darwin.weekly-review`): `launchd` canonical
