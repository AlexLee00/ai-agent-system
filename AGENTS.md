# AGENTS.md

## 목적

- 이 파일은 `ai-agent-system` 저장소에서 코덱과 Claude Code가 공통으로 따라야 하는 세션 운영 규칙을 고정한다.
- 특히 세션 시작/마감 시 문서 인수인계 루프가 누락되지 않도록 하는 것이 목적이다.

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
- 비디오팀 작업은 아래 순서를 추가로 따른다.
  1. [bots/video/docs/CLAUDE.md](/Users/alexlee/projects/ai-agent-system/bots/video/docs/CLAUDE.md)
  2. [bots/video/docs/VIDEO_HANDOFF.md](/Users/alexlee/projects/ai-agent-system/bots/video/docs/VIDEO_HANDOFF.md)
  3. [bots/video/docs/video-team-design.md](/Users/alexlee/projects/ai-agent-system/bots/video/docs/video-team-design.md)
  4. [bots/video/samples/ANALYSIS.md](/Users/alexlee/projects/ai-agent-system/bots/video/samples/ANALYSIS.md)
  5. [bots/video/docs/video-team-tasks.md](/Users/alexlee/projects/ai-agent-system/bots/video/docs/video-team-tasks.md)

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
5. `git status`를 확인하고, 마감 가능한 상태면 커밋/푸시까지 완료한다.
6. 커밋하지 못한 변경이 남으면 이유와 다음 단계가 handoff 문서에 드러나야 한다.

## 역할 경계

- Claude:
  - 문서를 읽고 구조를 해석한다.
  - 설계 검토, 구현 프롬프트 작성, 작업 순서 정리에 집중한다.
  - 코드 직접 수정 주체로 가정하지 않는다.

- 코덱(Codex) / Claude Code:
  - 실제 파일 생성/수정, 테스트, 문서 업데이트, 커밋/푸시를 수행한다.
  - 구현이 끝난 뒤 문서 반영과 git 마감까지 함께 처리한다.

## 비디오팀 현재 원칙

- 비디오팀 과제명은 `유튜브 영상편집 자동화`다.
- 현재 `bots/video`는 문서 기준점이 정리된 상태이며, 구현 스캐폴딩은 아직 시작 전이다.
- 렌더링/오디오 확정값은 [bots/video/docs/CLAUDE.md](/Users/alexlee/projects/ai-agent-system/bots/video/docs/CLAUDE.md)를 source of truth로 본다.
- 과제 프롬프트의 하드코딩보다 `config/video-config.yaml` 참조를 우선한다.

## 공통 원칙

- 기존 아키텍처와 레이어를 존중한다.
- 전면 재설계보다 기존 공용 레이어 확장을 우선 검토한다.
- deterministic pipeline을 우선하고, LLM은 보조 레이어로 붙인다.
- 로그, 실행 이력, 실패 이력, 사용자 수정 이력을 중요하게 다룬다.
- 내부 MVP는 빠르게 가되, 정확성과 안정성을 우선한다.
