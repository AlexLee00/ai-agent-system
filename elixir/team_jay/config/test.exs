import Config

# 테스트 환경: MCP HTTP 서버 비활성화 (포트 충돌 방지)
config :team_jay, :sigma_mcp_enabled_override, false

# 테스트는 검증만 수행해야 하며 Codex 자동구현 파이프라인을 실행하면 안 된다.
config :team_jay, :codex_auto_execute, false
