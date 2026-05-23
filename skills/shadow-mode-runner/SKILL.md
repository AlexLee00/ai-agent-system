---
name: shadow-mode-runner
description: 신규 전략, 게시 자동화, 운영 변경을 live 전환 전에 shadow/dry-run으로 검증할 때 사용.
---

# Shadow Mode Runner

## 목적

새 로직을 live에 바로 연결하지 않고 shadow 또는 dry-run으로 충분한 증거를 쌓는다.

## 절차

1. 대상 정의: 전략, 게시, 라우팅, dashboard card 등 변경 대상을 정한다.
2. Shadow 입력 연결: live 입력을 읽되 write sink는 artifact/report로 돌린다.
3. 기간/샘플 목표 설정: 최소 실행 횟수, 실패 허용치, 품질 기준을 정한다.
4. 관측 지표 기록: success, skip, blocker, latency, mismatch, fallback을 기록한다.
5. Promotion 판단: pass/fail만 보고하고 자동 promote는 하지 않는다.

## 팀 제이 규칙

- live trade, live publish, rollback, protected PID 조작은 shadow에서 실행하지 않는다.
- 테스트 게시물은 테스트 플래그를 남겨 운영 데이터에 반영하지 않는다.
- 실패는 숨기지 않고 artifact에 기록한다.
- promotion gate PASS도 자동 전환 승인은 아니다.

## 출력 형식

```text
Target:
Duration/sample goal:
Write sink:
Metrics:
Blockers:
Promotion recommendation:
```
