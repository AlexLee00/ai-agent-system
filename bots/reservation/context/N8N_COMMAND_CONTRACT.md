# 스카 n8n Command Contract

스카 `n8n` 명령 경로는 현재 아래 로컬 bridge endpoint를 기준으로 맞춘다.

- endpoint:
  - `POST /api/webhooks/n8n/ska-command`
- server:
  - `scripts/dashboard-server.js`

## 공통 요청 형식

```json
{
  "command": "query_reservations",
  "args": {
    "date": "2026-03-15"
  }
}
```

## 공통 응답 원칙

- 항상 JSON 반환
- `ok: true|false` 포함
- 성공 시 `source`는 `ska-webhook` 또는 `n8n`
- 실패 시 `error` 문자열 포함

## 지원 명령

### `query_reservations`

요청:

```json
{
  "command": "query_reservations",
  "args": {
    "date": "2026-03-15"
  }
}
```

응답:

```json
{
  "ok": true,
  "date": "2026-03-15",
  "count": 3,
  "reservations": [
    "10:00~12:00 [A1] confirmed"
  ],
  "source": "ska-webhook"
}
```

### `query_today_stats`

요청:

```json
{
  "command": "query_today_stats",
  "args": {
    "date": "2026-03-15"
  }
}
```

응답:

```json
{
  "ok": true,
  "date": "2026-03-15",
  "total_amount": 120000,
  "entries_count": 11,
  "source": "ska-webhook"
}
```

### `query_alerts`

요청:

```json
{
  "command": "query_alerts",
  "args": {
    "limit": 10
  }
}
```

응답:

```json
{
  "ok": true,
  "count": 2,
  "alerts": [],
  "past_cases": [],
  "source": "ska-webhook"
}
```

### `store_resolution`

요청:

```json
{
  "command": "store_resolution",
  "args": {
    "issueType": "결제오류",
    "detail": "픽코 중복 승인",
    "resolution": "수동 환불 후 재동기화"
  }
}
```

응답:

```json
{
  "ok": true,
  "message": "RAG 저장 완료",
  "source": "ska-webhook"
}
```

## 보안 규칙

- localhost 요청만 허용
- `SKA_WEBHOOK_SECRET`가 설정된 경우 `x-ska-webhook-secret` 일치 필요

## 이관 원칙

1. 새 명령은 먼저 `bridge endpoint`에 계약을 추가
2. 그다음 `n8n workflow`에서 호출
3. 마지막에 `ska-command-handlers.js`의 local fallback과 결과 shape를 맞춘다
