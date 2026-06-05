# 리팩토링 가이드 (Refactoring Guide)

> 일관적·안전한 코드 리팩토링을 위한 팀 제이 표준. refactorer 에이전트·코덱스·기여자 모두 이 가이드를 따른다.
> 작성 2026-06-06 (메티). 기반: 외부 권위 자료 심도 서칭 + CODEX_CLAUDE_REFACTORER_HARNESS_2026-05-28 + 실측 기술부채.

## 0. 핵심 원칙 (불변)
1. **No one-shot**: 한 번에 대형 리팩토링 금지. 분석 → 분할 → 검증 단계로.
2. **작은 배치**: 1회 5~20 파일, 작은 PR/커밋, 명확한 롤백 지점.
3. **테스트·린트 게이트**: 모든 변경은 `tsc --noEmit` + 테스트 + 린트 통과 후. 테스트 없으면 먼저 작성(TDD red-green-refactor).
4. **행위 보존**: 리팩토링은 기능을 바꾸지 않는다. 동작 변경은 리팩토링이 아니라 별도 작업.
5. **측정**: 기술부채 지표(§6)를 변경 전후로 기록.
6. **branching by abstraction**: 큰 구조 변경은 추상화 계층을 먼저 두고 점진 전환(무중단 릴리스).

## 1. 제약 (팀 제이 불변)
- **crypto 무중단**: 루나(binance/upbit) 실거래 경로는 리팩토링 중에도 중단 없음. 관련 파일은 shadow/단계 적용.
- **PROTECTED launchd 11개**(ai.{ska,luna,investment,claude,elixir,hub}.*) 직접 중지 금지.
- **역할 경계**: 메티(설계·검증) → 코덱스(구현) → 마스터(승인·git). 메티는 코드 직접 수정 안 함.
- **git**: main 직접, 중요 리팩토링 전 `git tag`(롤백 지점) 생성.

## 2. 우선순위 (영향 × 위험)
실측 기술부채(2026-06-06):
- **@ts-nocheck 1,667 / 2,544 파일 (65.5%)** ← 최대, 증가 추세(2026-05-28 62.5% → 65.5%)
- **대형 파일**: commenter.ts 6,215줄 / auto-dev-pipeline.ts 3,979 / hanul.ts 3,751 / health-report.ts 3,012 / router.ts 2,947

순서:
1. **@ts-nocheck 복구** (소형 파일·저위험 팀부터; crypto 연계 파일 마지막)
2. **1,500줄+ 대형 파일 분할** (단일 책임)
3. **중복 패턴 → 공통 유틸 추출**

## 3. @ts-nocheck 복구 전략
1. **개별 strict 플래그 점진**: `strict:true` 한 방 금지. noImplicitAny → strictNullChecks 순으로, 플래그별 에러 수 측정 후 적은 것부터.
2. **ratchet 패턴**: 신규 파일은 strict default, 기존 파일만 @ts-nocheck 유지 → 새 부채 증가 차단.
3. **pre-commit hook**: 편집하는 파일은 @ts-nocheck 제거를 강제(우리 hooks/refactor-hooks/pre-refactor-hook 활용). 백로그 우선순위에 의존하지 않음.
4. **leaf module 먼저**: 의존성 말단부터 inward.
5. **@ts-ignore/@ts-expect-error 남용 금지**: 라인 전체 에러를 가리므로, narrowing으로 실제 해소.
6. **CI gate**: `tsc --noEmit` + ESLint no-explicit-any + ts-prune(unused export).

## 4. 대형 파일 분할
1. **단일 책임 원칙(SRP)**: 책임별 모듈 분리.
2. **Scoped(분할 단위)**: 한 번에 한 책임씩, 작은 PR.
3. **branching by abstraction**: 인터페이스/어댑터를 먼저 두고 호출부 점진 이동.
4. **전역 상태 → scoped service**.
5. 분할 후 import·테스트 전부 통과 확인.

## 5. 검증 (plugin-eval 3계층)
모든 리팩토링은 `lib/refactor-harness/plugin-eval` 3계층 통과:
1. **Static**: `tsc --noEmit` + 린트 + `git diff --check`.
2. **LLM Judge**: 행위 보존·가독성·SRP 준수 평가.
3. **Monte Carlo / 테스트**: 단위·smoke 테스트 반복.
- 대상의 기존 테스트 green 유지(red 발생 시 즉시 중단·롤백).

## 6. 메트릭 (변경 전후 기록)
- @ts-nocheck 파일 수 / 비율
- 1,500줄+ 파일 수
- `tsc --noEmit` 에러 수
- build time
- 새 strict 체크로 잡힌 production incident
- 테스트 커버리지

## 7. 거버넌스
- **한 팀(refactorer) 주도**: 전문성 집중 + 자동화 + 완료 확률↑ (Stripe Sorbet 패턴).
- **AI 제안 → 인간 승인**: refactorer/코덱스가 편집 제안, 메티 검증, 마스터 승인.
- **advisory 우선**: 새 패턴은 shadow/advisory로 먼저, 게이트 통과 후 적용.

## 8. 워크플로 (1 사이클)
1. 대상 선정(§2 우선순위) + `git tag` 롤백 지점.
2. 테스트 존재 확인(없으면 작성).
3. 작은 배치(5~20 파일) 리팩토링.
4. plugin-eval 3계층(§5) 통과.
5. 메트릭(§6) 기록.
6. 메티 검증 → 마스터 커밋(작은 PR).
7. 실패 시 git tag로 롤백.

## 9. 외부 참조 (2026 심도 서칭)
- **리팩토링 원칙**: incremental/phased/measurement, no one-shot, 작은 배치+롤백 (getdx, 5ly, Tembo, InfoQ QCon SF 2024 Stripe Sorbet).
- **AI 리팩토링**: AI 제안+인간 승인, 5~20 파일 배치, advisory(write 점진), static analysis 파이프라인 (Augment Code, Claude Code plugin best practices 2025).
- **TS strict**: 개별 플래그 점진, ratchet(신규 strict+기존 ignore), pre-commit 강제, leaf-first, 메트릭, CI `tsc --noEmit` gate, TS 6(2026-03) strict default (allegro/typescript-strict-plugin, Propel, knowledgelib, ycmjason/ts-migrating).
- **내부**: CODEX_CLAUDE_REFACTORER_HARNESS_2026-05-28 (wshobson plugin-eval 3계층, supatest Technical Debt Analyst, TDD red-green-refactor, Scoped, moai-adk TRUST gates).
