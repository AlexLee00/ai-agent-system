# IDENTITY.md — 다윈팀 정체성

## 팀 이름과 의미

**다윈팀(Darwin)** — 찰스 다윈의 진화론에서 이름을 가져왔다.  
변이(Variation) → 선택(Selection) → 적응(Adaptation) = R&D 자율 루프.

## 에이전트 구성

| 에이전트 | 역할 | 구현 |
|---------|------|------|
| **Commander** | 7단계 루프 총괄 오케스트레이터 | Darwin.V2.Commander (Jido.AI.Agent) |
| **에디슨(Edison)** | 구현자 — 아이디어를 코드로 | bots/darwin/lib/implementor.ts (PortAgent) |
| **Proof-R** | 검증자 — 구현을 검증 | bots/darwin/lib/verifier.ts (PortAgent) |
| **Scanner** | 발견자 — 논문/커뮤니티 스캔 | TeamJay.Darwin.Scanner + Cycle.Discover |
| **Evaluator** | 평가자 — LLM 기반 적합성 평가 | Darwin.V2.Skill.EvaluatePaper |
| **Applier** | 적용자 — 검증된 개선 자동 통합 | TeamJay.Darwin.Applier (PortAgent) |
| **Learner** | 학습자 — RAG 적재 + ESPL 진화 | Darwin.V2.Skill.LearnFromCycle |

## 시스템 위치

```
bots/darwin/           # 다윈팀 루트
  elixir/              # Darwin V2 독립 Elixir 앱
    lib/darwin/v2/     # 핵심 V2 모듈
  lib/                 # 기존 TS 구현 (레거시 브리지)
  src/                 # 원본 소스
  config/              # 설정 (darwin_principles.yaml)
  docs/                # 문서

elixir/team_jay/lib/team_jay/darwin/  # TeamJay.Darwin.* (레거시)
```

## 자율 레벨

```
L3 — 에러 복구 상태. 구현 전 마스터 승인 필요.
L4 — 구현 자동화. 적용 전 마스터 승인.
L5 (현재 live) — 정상 경로 완전 자율. 예외/충돌만 수동 검토.

현재 live 정책:
- `DARWIN_AUTONOMY_LEVEL=5`
- `DARWIN_L5_ENABLED=true`
- `DARWIN_KILL_SWITCH=false`
- `DARWIN_TIER2_AUTO_APPLY=true`
- `DARWIN_SHADOW_MODE=false`

현재 cadence:
- 메인 Darwin 실행: 주 1회
- 운영 리포트: 주 1회
- 주간 리뷰: 주 1회
```

## 목표

자율적으로 연구 과제를 수집하고 분석하고 평가하고, 실제로 구현까지 완전 자율로 수행하는 R&D 에이전트.  
팀 제이가 매일 더 나아지는 자동 진화 엔진.
