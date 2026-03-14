# 워커팀 n8n 워크플로우 초안

## 목적
- 자연어 업무 요청을 n8n에서 받아 워커팀 `chat-agent`로 전달
- 결과에 따라
  - 즉시 응답
  - 승인 대기
  - task 완료 후 후속 분기
  를 오케스트레이션

## 핵심 엔드포인트

### 1. 자연어 입력
- `POST /api/webhooks/n8n/chat-intake`
- 인증:
  - `x-worker-webhook-secret: <worker_webhook_secret>`
- 요청 예시:

```json
{
  "company_id": "master",
  "user_id": 1,
  "message": "오늘 매출 보고서 만들어줘",
  "session_id": null
}
```

- 응답 예시:

```json
{
  "ok": true,
  "sessionId": "uuid",
  "reply": "oliver 담당 업무로 등록했습니다. 처리 대기열에 넣었습니다.",
  "intent": "route_request",
  "ui": {
    "type": "route"
  }
}
```

### 2. task 상태 조회
- `GET /api/webhooks/n8n/agent-tasks/:id`
- 인증:
  - `x-worker-webhook-secret: <worker_webhook_secret>`

## 추천 n8n 흐름

1. Webhook Trigger
2. HTTP Request
   - `POST /api/webhooks/n8n/chat-intake`
3. IF
   - `ui.type === 'route'`
4. Wait / Poll
   - `GET /api/webhooks/n8n/agent-tasks/:id`
5. IF
   - `task.status === 'completed'`
   - `task.status === 'pending_approval'`
   - `task.status === 'failed'`
6. 후속 알림/메일/외부시스템 반영

## 운영 메모
- 승인 필요한 업무는 `pending_approval` 상태로 시작합니다.
- 승인되면 워커 실행기가 `queued -> processing -> completed`로 처리합니다.
- 웹 UI/WebSocket과 텔레그램 자연어 채널은 같은 `chat-agent`를 재사용합니다.
