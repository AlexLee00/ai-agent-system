---
name: subagent-driven-development
description: 복잡한 개발 작업을 구현자, 리뷰어, 검증자로 분리해 진행할 때 사용. 큰 변경, 다팀 영향, 회귀 위험이 있는 작업에 적용.
---

# Subagent-Driven Development

## 목적

작업을 한 번에 밀어붙이지 않고 역할별로 분리한다.

1. Planner: 요구사항, 범위, 금지사항, 완료 조건 정리
2. Builder: 제한된 파일 범위에서 구현
3. Reviewer: correctness/security/regression 중심 검토
4. Verifier: 테스트, smoke, 운영 가드 확인

## 절차

1. 작업 분해: 입력, 변경 대상, 위험도, 완료 조건을 분리한다.
2. 역할 배정: 구현/리뷰/검증을 같은 관점으로 반복하지 않도록 나눈다.
3. 범위 잠금: 허용 파일, 금지 파일, 실서비스 금지 동작을 명시한다.
4. 구현: 최소 변경으로 목표를 충족한다.
5. 독립 리뷰: 변경 diff만 보지 말고 실제 동작 경로를 확인한다.
6. 검증: 테스트 결과, 미검증 항목, 잔여 리스크를 기록한다.

## 팀 제이 규칙

- 루나팀 live trade, rollback, protected PID 조작은 명시 승인 없이는 금지한다.
- secret 변경, commit/push, launchctl load/unload는 별도 승인 범위로 분리한다.
- dirty worktree가 있으면 기존 사용자 변경과 신규 변경을 섞지 않는다.
- 리뷰 결과는 수정 가능한 항목만 남기고, 추측성 피드백은 제외한다.

## 출력 형식

```text
Goal:
Scope:
Blocked actions:
Builder changes:
Reviewer findings:
Verification:
Remaining risk:
```
