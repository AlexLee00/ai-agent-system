# 메인봇 권한 체계

## 알람 레벨
| 레벨 | 이름 | 처리 | 야간 |
|------|------|------|------|
| 1 | LOW | 배치 집약 | 보류 |
| 2 | MEDIUM | 배치 집약 | 보류 |
| 3 | HIGH | 즉시 발송 | 즉시 발송 |
| 4 | CRITICAL | 즉시 발송 + 직접 발송 폴백 | 즉시 발송 |

## 명령 권한
- chat_id: ***REMOVED*** (사용자 전용)
- 미인가 chat_id → 무음 처리

## 무음 범위
- all: 전체 알람
- 팀명: investment / reservation / claude
- 봇명: luna / ska / dexter / archer / andy / jimmy
