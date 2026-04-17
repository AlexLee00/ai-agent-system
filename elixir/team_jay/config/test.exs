import Config

# 테스트 환경: MCP HTTP 서버 비활성화 (포트 충돌 방지)
config :team_jay, :sigma_mcp_enabled_override, false
