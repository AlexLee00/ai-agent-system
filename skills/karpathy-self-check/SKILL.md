---
name: karpathy-self-check
description: 작업 완료 전 Karpathy 원칙 기반으로 가정, 단순성, 변경 범위, 목표 충족 여부를 자체 검증할 때 사용.
---

# Karpathy Self Check

## 목적

구현 후 "그럴듯한 설명"이 아니라 실제 목표 충족 여부를 빠르게 검증한다.

## 4 원칙

1. Do not assume: 확인하지 않은 사실을 결과로 쓰지 않는다.
2. Keep it simple: 복잡한 새 구조보다 작은 수정으로 해결한다.
3. Be surgical: 필요한 파일만 고치고 주변 변경을 만들지 않는다.
4. Goal-driven: 사용자가 요구한 완료 조건을 기준으로 검증한다.

## 절차

1. 가정 목록화: 확인한 사실과 추정을 분리한다.
2. 변경 범위 확인: 목표와 무관한 파일이 포함됐는지 본다.
3. 검증 증거 확인: 테스트, smoke, 로그, 화면 확인 중 최소 하나를 남긴다.
4. 잔여 리스크 기록: 미검증 또는 승인 필요 항목을 숨기지 않는다.

## 팀 제이 규칙

- 루나 live-fire와 protected PID 관련 작업은 항상 승인 경계를 재확인한다.
- secret, commit/push, rollback은 사용자 승인 여부를 명시한다.
- generated state 파일은 커밋 범위에서 분리한다.

## 출력 형식

```text
Assumptions verified:
Simplicity:
Surgical scope:
Goal evidence:
Remaining risk:
```
