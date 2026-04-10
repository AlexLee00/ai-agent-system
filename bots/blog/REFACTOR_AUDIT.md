# Blog Refactor Audit

Updated: 2026-04-11

## Promoted to Core

- `instagram-publisher` -> `/Users/alexlee/projects/ai-agent-system/packages/core/lib/instagram-graph.ts`
  - 이유: 블로그 전용 도메인 로직이 아니라 Graph API 업로드 공용 기능
  - 현재 사용처: 블로그 릴스 업로드/ready 체크

## Keep in Blog

- `blo.ts`, `maestro.ts`, `gems-writer.ts`, `pos-writer.ts`
  - 블로그 파이프라인 자체이므로 팀 내부 유지가 맞음
- `commenter.ts`
  - 네이버 블로그 UI와 워크플로우에 강하게 결합
- `curriculum-planner.ts`, `schedule.ts`, `schema.ts`, `topic-selector.ts`
  - 블로그 운영 정책/캘린더/주제 전략에 결합
- `shortform-planner.ts`, `shortform-renderer.ts`, `shortform-files.ts`, `star.ts`
  - 사용자 결정: 숏폼은 블로그 내부 유지
  - CTA, 썸네일 네이밍, 릴스 캡션, 블로그 출력 구조가 강하게 섞여 있음

## Conditional Core Candidates

- `shortform-renderer.ts`
  - `ffmpeg` 렌더와 세로 릴스 합성은 다른 팀도 재사용 가능
  - 단, 현재는 블로그 제목/오버레이 구조가 강하게 섞여 있어 당분간 블로그 내부 유지
- `shortform-planner.ts`
  - 길이 정규화, 스토리보드 분할, ffmpeg preview 명령은 공용화 가치 있음
  - 훅 문구/오버레이 문안 생성은 블로그 특화라 순수 계산 파트 분리 전까지 내부 유지
- `performance-diagnostician.ts` / `strategy-evolver.ts`
  - 성과 진단 프레임은 공용화 가능
  - 하지만 입력 스키마가 `blog.posts`, `execution_history` 전용이라 먼저 인터페이스 분리가 필요

## Recent Internal Refactors

- `blo.ts`
  - 일반 글 준비를 `주제 전략 적용` / `도서리뷰 자료 준비`로 분리
  - 계약 고용, 평가, 발행 후처리, 초안 생성 러너를 공통 함수로 정리
  - 메인 `run()`은 `준비 → 강의/일반 단계 실행 → 리포트 → 후처리` 구조로 단순화
- `maestro.ts`
  - variation 선택, gemma 추천, n8n 트리거, competition 조건을 개별 함수로 분리
  - 세션 로그 및 payload/result 조립을 함수로 정리
- `commenter.ts`
  - 댓글창 열기, 제출 검증, 직접 댓글 액션 기록, 이웃 댓글 성공 기록을 분리
- `schema.ts`
  - 블로그 코어 테이블 self-healing 계층 추가
  - DB 접근 제한 시 verify가 합성 스케줄로 내려가도록 지원

## Current Runtime Notes

- 이 대화 환경에서는 PostgreSQL 접근이 `EPERM`으로 막혀 있어 verify가 합성 스케줄로 동작할 수 있음
- 운영 환경에서는 실제 DB를 사용하고, 현재 verify는 이 제한을 오류가 아닌 환경 경고로 표시함

## Next Refactor Order

1. `blo.ts`의 lecture/general context 반환 스키마를 더 일관되게 정리
2. `maestro.ts`의 pipeline/variation/result 타입 경계를 명확히 정리
3. `performance-diagnostician.ts` 입력 계약을 일반화한 뒤 core 승격 검토
