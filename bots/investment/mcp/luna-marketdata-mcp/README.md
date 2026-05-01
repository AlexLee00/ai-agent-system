# Luna Marketdata MCP

Wave 1 병렬 검증용 market-data MCP 서버입니다.

- 기존 `ai.luna.*-ws` launchd를 대체하지 않습니다.
- 주문, 정산, 포지션 변경 API를 제공하지 않습니다.
- JSON-RPC `tools/list`, `tools/call`과 `/health`만 제공합니다.
- 기본 포트는 `LUNA_MARKETDATA_MCP_PORT=4088`입니다.
- Binance는 공개 WebSocket/Depth REST를 우선 사용하고 실패 시 deterministic fallback으로 후퇴합니다.
- KIS/TradingView는 인증 또는 로컬 서비스가 준비된 경우 실시간/REST 경로를 사용하고, 아니면 fallback으로 닫힙니다.
