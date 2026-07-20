# AGENTS.md

## 목적

- 이 파일은 `ai-agent-system` 저장소에서 코덱과 Claude Code가 공통으로 따라야 하는 세션 운영 규칙을 고정한다.
- 특히 세션 시작/마감 시 문서 인수인계 루프가 누락되지 않도록 하는 것이 목적이다.

## 구현 거버넌스 자동 적용

작업 착수 전에 변경을 아래 세 단계 중 하나로 분류한다. 파일 수나 line count가 아니라 운영 영향, 외부 I/O, 데이터 변경 가능성, 롤백 난이도로 판단하며 모호하면 더 높은 단계로 올린다.

- **T0 Lean**: 문구, 주석, 포맷, 비운영 문서·표시용 소규모 설정, 테스트 설명처럼 런타임 동작이 바뀌지 않는 변경이다. 최소 범위 수정과 직접 관련된 확인만 수행하며 전문가 회의, RED 테스트, 하드 테스트를 자동으로 요구하지 않는다.
- **T1 Governed**: 비자명한 소스 로직, 다팀 계약, provider/model/timeout/retry/schedule/limit, 인증, DB 조회·상태 판정, 외부 I/O 동작을 바꾸는 변경이다. 한 줄 변경이어도 해당하며 [implementation-governance](/Users/alexlee/projects/ai-agent-system/skills/implementation-governance/SKILL.md)를 읽고 적용한다.
- **T2 Protected**: launchd 재시작·변경, 실주문·결제·예약·발행, 운영 DB 쓰기·migration, secret 변경, commit/push처럼 별도 승인이 필요한 실행 오버레이이다. 기본 변경은 T0/T1 절차를 유지하고, 실제 mutation 직전에 현재 작업에 대한 명시 승인을 추가로 확인한다.

T1 변경과 그 위에 적용된 T2에서는 개발, 도메인, SRE/데이터, 테스트 관점의 반박을 모으되 **one implementation owner**만 소스를 수정한다. T0에 commit/push 같은 T2 승인만 얹힌 경우에는 전체 전문가 절차로 승격하지 않는다. 각 관점은 반대 의견, 근거, 수용/기각 사유를 짧게 남기며 안전성·정확성·데이터 손실·롤백 가능성에 미해결 이견이 없어야 구현한다. DB 정합성, 런타임 drift, read-only hard test, 리팩터링은 변경과 관련 있을 때만 수행하고, 관련 없으면 이유와 함께 생략한다.

## 세션 시작 규칙

새 세션을 시작할 때는 아래 순서를 먼저 읽는다.

1. [CLAUDE.md](/Users/alexlee/projects/ai-agent-system/CLAUDE.md)
2. [docs/SESSION_CONTEXT_INDEX.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_CONTEXT_INDEX.md)
3. [docs/SESSION_HANDOFF.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_HANDOFF.md)
4. [docs/PLATFORM_IMPLEMENTATION_TRACKER.md](/Users/alexlee/projects/ai-agent-system/docs/PLATFORM_IMPLEMENTATION_TRACKER.md)
5. [docs/WORK_HISTORY.md](/Users/alexlee/projects/ai-agent-system/docs/WORK_HISTORY.md)
6. [docs/RESEARCH_JOURNAL.md](/Users/alexlee/projects/ai-agent-system/docs/RESEARCH_JOURNAL.md)

추가 원칙:
- 작업 착수 전 현재 세션과 직접 관련된 팀 handoff 문서가 있으면 함께 읽는다.
- 워커팀과 에디팀은 2026-04-30부로 은퇴 처리됐다. 설계 기록은 [worker archive](/Users/alexlee/projects/ai-agent-system/docs/archive/retired-teams/worker/README.md), [edi archive](/Users/alexlee/projects/ai-agent-system/docs/archive/retired-teams/edi/README.md)에서만 확인한다.

## 세션 마감 규칙

세션을 마감하기 전에는 아래를 반드시 확인한다.

1. 이번 세션에서 실제로 무엇이 바뀌었는지 요약 가능해야 한다.
2. 테스트/검증 결과가 있으면 기록한다.
3. 아래 문서의 갱신 필요 여부를 확인한다.
   - [docs/SESSION_HANDOFF.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_HANDOFF.md)
   - [docs/WORK_HISTORY.md](/Users/alexlee/projects/ai-agent-system/docs/WORK_HISTORY.md)
   - [docs/CHANGELOG.md](/Users/alexlee/projects/ai-agent-system/docs/CHANGELOG.md)
   - [docs/TEST_RESULTS.md](/Users/alexlee/projects/ai-agent-system/docs/TEST_RESULTS.md)
4. 팀별 handoff를 수정했다면 전사 handoff와 상태가 충돌하지 않는지 다시 확인한다.
5. `git status`를 확인하고, 커밋/푸시는 현재 작업에서 사용자가 명시적으로 요청한 경우에만 수행한다.
6. 커밋하지 못한 변경이 남으면 이유와 다음 단계가 handoff 문서에 드러나야 한다.

## 역할 경계

- Claude:
  - 문서를 읽고 구조를 해석한다.
  - 설계 검토, 구현 프롬프트 작성, 작업 순서 정리에 집중한다.
  - 코드 직접 수정 주체로 가정하지 않는다.

- 코덱(Codex) / Claude Code:
  - 실제 파일 생성/수정, 테스트, 문서 업데이트, 커밋/푸시를 수행한다.
  - 구현이 끝난 뒤 문서 반영과 git 마감까지 함께 처리한다.

## 공통 원칙

- 기존 아키텍처와 레이어를 존중한다.
- 전면 재설계보다 기존 공용 레이어 확장을 우선 검토한다.
- deterministic pipeline을 우선하고, LLM은 보조 레이어로 붙인다.
- 로그, 실행 이력, 실패 이력, 사용자 수정 이력을 중요하게 다룬다.
- 내부 MVP는 빠르게 가되, 정확성과 안정성을 우선한다.
