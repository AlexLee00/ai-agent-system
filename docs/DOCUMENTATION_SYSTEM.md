# 문서 체계 운영 가이드

> 마지막 업데이트: 2026-03-18  
> 목적: 세션이 바뀌어도 같은 순서로 문서를 읽고, 같은 기준으로 문서를 갱신할 수 있도록 문서 역할과 흐름을 고정한다.

---

## 1. 이 문서의 역할

- 이 문서는 `문서의 인덱스`가 아니라 `문서 체계의 규칙`을 설명한다.
- 세션 시작 시 어떤 문서를 읽고, 각 문서가 무엇을 담당하며, 어떤 문서를 업데이트해야 하는지를 정의한다.
- 목표는 다음 하나다.
  - `세션이 끊겨도 개발이 끊기지 않는 상태`

---

## 2. 문서 체계의 핵심 원칙

- 문서는 역할이 겹치지 않아야 한다.
- `현재 상태(As-Is)`와 `다음 계획(To-Be)`은 분리해서 기록한다.
- 세션 시작에 필요한 문서는 적고 선명해야 한다.
- 팀별 구현 위치 탐색 문서와 설계/정책 문서는 분리한다.
- 기록 문서는 사실 중심 로그와 사고 흐름 기록을 나눠서 유지한다.
- 외부 의존성 문서(`node_modules`, `venv`, generated output`)는 세션 문서 체계에서 제외한다.

---

## 3. 세션 시작 시 읽는 순서

### 3.1 최소 읽기 경로

1. [CLAUDE.md](/Users/alexlee/projects/ai-agent-system/CLAUDE.md)
2. [SESSION_CONTEXT_INDEX.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_CONTEXT_INDEX.md)
3. [DOCUMENTATION_SYSTEM.md](/Users/alexlee/projects/ai-agent-system/docs/DOCUMENTATION_SYSTEM.md)
4. [SESSION_HANDOFF.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_HANDOFF.md)
5. [PLATFORM_IMPLEMENTATION_TRACKER.md](/Users/alexlee/projects/ai-agent-system/docs/PLATFORM_IMPLEMENTATION_TRACKER.md)

### 3.2 상황별 추가 읽기

- 구조/아키텍처를 이해해야 할 때
  - [SYSTEM_DESIGN.md](/Users/alexlee/projects/ai-agent-system/docs/SYSTEM_DESIGN.md)
- 팀별 구현 위치를 찾아야 할 때
  - [docs/team-indexes/README.md](/Users/alexlee/projects/ai-agent-system/docs/team-indexes/README.md)
- 운영 중 변경 가능한 설정을 봐야 할 때
  - [TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md](/Users/alexlee/projects/ai-agent-system/docs/TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md)
- 현재 이슈를 봐야 할 때
  - [KNOWN_ISSUES.md](/Users/alexlee/projects/ai-agent-system/docs/KNOWN_ISSUES.md)

---

## 4. 문서 역할 정의

### 4.1 정책 / 세션 규칙

- [CLAUDE.md](/Users/alexlee/projects/ai-agent-system/CLAUDE.md)
  - 세션 규칙, 개발 루틴, 문서 업데이트 원칙

### 4.2 세션 시작 인덱스

- [SESSION_CONTEXT_INDEX.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_CONTEXT_INDEX.md)
  - 세션 시작 시 읽을 문서와 팀별 빠른 진입 경로

### 4.3 문서 체계 설명

- [DOCUMENTATION_SYSTEM.md](/Users/alexlee/projects/ai-agent-system/docs/DOCUMENTATION_SYSTEM.md)
  - 문서 간 역할 분리와 읽는 순서

### 4.4 시스템 구조 / 기준 설계

- [SYSTEM_DESIGN.md](/Users/alexlee/projects/ai-agent-system/docs/SYSTEM_DESIGN.md)
  - 전체 시스템 구조
- [coding-guide.md](/Users/alexlee/projects/ai-agent-system/docs/coding-guide.md)
  - 구현 규칙, 운영 원칙
- [team-features.md](/Users/alexlee/projects/ai-agent-system/docs/team-features.md)
  - 팀별 기능 축 개요

### 4.5 현재 구현 상태 / 개발 계획

- [PLATFORM_IMPLEMENTATION_TRACKER.md](/Users/alexlee/projects/ai-agent-system/docs/PLATFORM_IMPLEMENTATION_TRACKER.md)
  - 현재 구현 상태, 진행 중 항목, 미완료 항목, 빠른 찾기

### 4.6 팀별 구현 위치 안내

- [docs/team-indexes/README.md](/Users/alexlee/projects/ai-agent-system/docs/team-indexes/README.md)
- 팀별 참조 문서 6종
  - 워커 / 루나 / 스카 / 클로드 / 제이 / 블로

### 4.7 운영 설정 / 운영 자동화

- [TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md](/Users/alexlee/projects/ai-agent-system/docs/TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md)
- [scripts/show-runtime-configs.js](/Users/alexlee/projects/ai-agent-system/scripts/show-runtime-configs.js)

### 4.8 세션 인수인계 / 현재 상태

- [SESSION_HANDOFF.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_HANDOFF.md)
  - 다음 세션이 바로 이어야 할 상태 요약

### 4.9 사실 기반 작업 기록

- [WORK_HISTORY.md](/Users/alexlee/projects/ai-agent-system/docs/WORK_HISTORY.md)
  - 날짜별 사실 기록
- [CHANGELOG.md](/Users/alexlee/projects/ai-agent-system/docs/CHANGELOG.md)
  - 기능 변경 이력
- [TEST_RESULTS.md](/Users/alexlee/projects/ai-agent-system/docs/TEST_RESULTS.md)
  - 테스트 실행 결과
- [KNOWN_ISSUES.md](/Users/alexlee/projects/ai-agent-system/docs/KNOWN_ISSUES.md)
  - 열린 이슈 / 모니터링 이슈

### 4.10 세션별 개발 기록 / 연구 기록

- [DEV_LOG.md](/Users/alexlee/projects/ai-agent-system/docs/DEV_LOG.md)
  - 세션 단위 사실+맥락 기록
- [DEV_VLOG.md](/Users/alexlee/projects/ai-agent-system/docs/DEV_VLOG.md)
  - 세션 단위 서술형 연구/회고 기록
- [RESEARCH_JOURNAL.md](/Users/alexlee/projects/ai-agent-system/docs/RESEARCH_JOURNAL.md)
  - 장기 연구/의사결정 저널

---

## 5. 세션 종료 시 반드시 갱신할 문서

### 필수

- [SESSION_HANDOFF.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_HANDOFF.md)
- [DEV_LOG.md](/Users/alexlee/projects/ai-agent-system/docs/DEV_LOG.md)
- [DEV_VLOG.md](/Users/alexlee/projects/ai-agent-system/docs/DEV_VLOG.md)

### 조건부

- 기능/구조 변경 시
  - [PLATFORM_IMPLEMENTATION_TRACKER.md](/Users/alexlee/projects/ai-agent-system/docs/PLATFORM_IMPLEMENTATION_TRACKER.md)
  - [SYSTEM_DESIGN.md](/Users/alexlee/projects/ai-agent-system/docs/SYSTEM_DESIGN.md)
  - 팀별 참조 문서
- 테스트 실행 시
  - [TEST_RESULTS.md](/Users/alexlee/projects/ai-agent-system/docs/TEST_RESULTS.md)
- 운영 이슈 갱신 시
  - [KNOWN_ISSUES.md](/Users/alexlee/projects/ai-agent-system/docs/KNOWN_ISSUES.md)
- 변경사항 커밋 시
  - [CHANGELOG.md](/Users/alexlee/projects/ai-agent-system/docs/CHANGELOG.md)
  - [WORK_HISTORY.md](/Users/alexlee/projects/ai-agent-system/docs/WORK_HISTORY.md)

---

## 6. 통폐합 원칙

### 유지

- 세션 시작 인덱스
- 구조 설계 문서
- 구현 추적 문서
- 팀별 참조 문서
- 운영 설정 가이드
- 로그/핸드오프/브이로그

### 통합 대상 원칙

- 내용이 `현재 상태 추적`이면
  - [PLATFORM_IMPLEMENTATION_TRACKER.md](/Users/alexlee/projects/ai-agent-system/docs/PLATFORM_IMPLEMENTATION_TRACKER.md)로 모은다
- 내용이 `세션 인수인계`면
  - [SESSION_HANDOFF.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_HANDOFF.md)로 모은다
- 내용이 `장기 연구/방법론`이면
  - [RESEARCH_JOURNAL.md](/Users/alexlee/projects/ai-agent-system/docs/RESEARCH_JOURNAL.md)로 모은다
- 내용이 `특정 기능의 깊은 설계/운영 지식`이면
  - 개별 기능 문서를 유지한다

### 삭제/세션 제외 기준

- `node_modules`, `venv` 내부 문서
- generated output
- third-party README / CHANGELOG
- 과거 리포트 산출물

이 문서들은 프로젝트의 실행에는 필요하지만 `세션 문서 체계`에는 포함하지 않는다.

---

## 7. 현재 문서 체계 판단

- 현재 체계는 `세션 시작 → 구조 이해 → 팀 탐색 → 현재 상태 확인 → 기록/인수인계` 흐름으로 재정렬 가능하다.
- 당장 불필요해서 삭제해야 할 핵심 문서는 보이지 않는다.
- 다만 아래 원칙은 유지해야 한다.
  - 새 기능을 만들면 먼저 팀 참조 문서와 구현 추적 문서를 갱신
  - 세션 종료 전에는 반드시 handoff/log/vlog를 갱신
