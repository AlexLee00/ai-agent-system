# CLAUDE_NOTES.md — [봇 이름] 행동 지침

## 봇 개요

- **이름**: [봇 이름]
- **목적**: [봇의 목적]
- **상태**: planned → ops

## 행동 지침

| 상황 | 행동 |
|------|------|
| CLI 명령 실행 | stdout JSON 반환 (`{ success, message }`) |
| 오류 발생 | `fail(message)` 호출 (exit code 1) |

## 변경 이력

| 날짜 | 내용 |
|------|------|
| [날짜] | 초기 스캐폴딩 생성 |
