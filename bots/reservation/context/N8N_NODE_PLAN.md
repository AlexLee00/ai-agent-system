# 스카 n8n 노드화 계획

## 목표
- 스카 커맨더의 명령 실행을 점진적으로 `n8n` 노드/워크플로로 이관
- `RAG`, `shared intent engine`, `shared health engine`을 같이 재사용
- 기존 `bot_commands` 인터페이스는 유지해서 제이 쪽 변경을 최소화

## 현재 구조
- 엔트리:
  - `src/ska.js`
- 명령 핸들러:
  - `lib/ska-command-handlers.js`
  - `lib/ska-intent-learning.js`
- 명령 큐:
  - `lib/ska-command-queue.js`
- 운영 모니터:
  - `auto/monitors/naver-monitor.js`
  - `auto/monitors/pickko-kiosk-monitor.js`

## 1차 노드화 대상
- `query_reservations`
- `query_today_stats`
- `query_alerts`

이유:
- 읽기 전용
- 부작용이 적음
- n8n HTTP/Code 노드로 옮기기 쉬움

## 2차 노드화 대상
- `store_resolution`
- `analyze_unknown`

이유:
- RAG / shared intent 저장 흐름을 그대로 재사용 가능
- 다만 저장/학습 흐름이라 감사 로그가 더 중요함

## 3차 노드화 대상
- `restart_andy`
- `restart_jimmy`

이유:
- 실제 운영 제어라 가장 보수적으로 가야 함
- launchd 호출은 커맨더 로컬 핸들러 fallback 유지 권장

## 권장 아키텍처
1. 제이 → `bot_commands`
2. 스카 커맨더 → `ska-command-queue`
3. 명령별 실행:
   - 우선 `local handler`
   - 이후 `n8n workflow handler`
   - 실패 시 `local fallback`
4. 결과 저장:
   - `bot_commands.result`
   - 필요 시 `RAG`
   - 필요 시 `promotion_events`

## 공용 레이어 적용 포인트
- n8n:
  - `packages/core/lib/n8n-runner.js`
- reservation RAG:
  - `packages/core/lib/reservation-rag.js`
- 인텐트:
  - `packages/core/lib/intent-core.js`
  - `packages/core/lib/intent-store.js`
- 헬스:
  - `packages/core/lib/health-core.js`
  - `packages/core/lib/health-provider.js`
  - `packages/core/lib/health-db.js`
- RAG:
  - `packages/core/lib/rag-safe.js`

## 구현 순서
1. 커맨더에서 queue/orchestration 분리
2. 읽기 전용 명령에 공용 `n8n handler adapter` 추가
3. `RAG` 저장 노드 공통화
4. 운영 제어 명령은 마지막에 이관

## 주의점
- `bot_commands` 계약은 유지
- 결과 JSON shape는 기존과 호환
- launchd/restart 계열은 로컬 fallback 반드시 유지
- `n8n` 장애 시 커맨더 전체가 멈추면 안 됨
