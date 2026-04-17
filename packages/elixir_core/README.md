# jay_core — 팀 제이 공용 Elixir 라이브러리

> **Namespace**: `Jay.Core.*`
> **버전**: 1.0.0
> **의존 앱**: team_jay / bots/sigma / bots/darwin / bots/jay

## 개요

`packages/elixir_core/`는 팀 제이 전체가 공유하는 공용 Elixir 라이브러리입니다.
`elixir/team_jay`에서 추출(Phase 2)되어 독립 라이브러리로 분리되었습니다.

## 포함 모듈

| 모듈 | 역할 |
|------|------|
| `Jay.Core.Repo` | Ecto Repo (PostgreSQL 연결) |
| `Jay.Core.HubClient` | Hub API 클라이언트 (시크릿/이벤트) |
| `Jay.Core.EventLake` | 이벤트 저장 + 조회 |
| `Jay.Core.JayBus` | 팀 간 이벤트 Registry 래퍼 |
| `Jay.Core.MarketRegime` | 시장 국면 분류 |
| `Jay.Core.Diagnostics` | 시스템 진단 + 헬스체크 |
| `Jay.Core.Scheduler` | Quantum 기반 스케줄러 |
| `Jay.Core.Config` | 환경 설정 |
| `Jay.Core.Agents.PortAgent` | 포트 기반 프로세스 관리 |
| `Jay.Core.Agents.Andy` | 알림 에이전트 |
| `Jay.Core.Agents.Jimmy` | 유틸 에이전트 |
| `Jay.Core.Agents.LaunchdShadowAgent` | launchd Shadow 모드 관리 |
| `Jay.Core.Schemas.EventLake` | Ecto 이벤트 스키마 |

## 의존성 추가 방법

```elixir
# 사용하는 앱의 mix.exs deps에 추가
{:jay_core, path: "../../../packages/elixir_core"}
```

## 단방향 의존 원칙

`packages/elixir_core`는 **어떤 `bots/*`도 참조하지 않습니다** (단방향 의존).
`bots/*` → `jay_core` 방향만 허용. 역방향 금지.

## JayBus 토픽 규약

```
sigma.advisory.*        — 시그마 directive
darwin.paper.*          — 다윈 논문 평가/구현
jay.cycle.*             — 제이 성장 사이클
luna.signal.*           — 루나 투자 신호
```
