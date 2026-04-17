import Config

config :darwin,
  anthropic_api_key: System.get_env("ANTHROPIC_API_KEY"),
  llm_daily_budget_usd:
    System.get_env("DARWIN_LLM_DAILY_BUDGET_USD", "10.0") |> String.to_float(),
  v2_enabled: System.get_env("DARWIN_V2_ENABLED", "false") == "true",
  shadow_mode: System.get_env("DARWIN_SHADOW_MODE", "true") == "true",
  kill_switch: System.get_env("DARWIN_KILL_SWITCH", "true") == "true",
  http_port: System.get_env("DARWIN_HTTP_PORT", "8180") |> String.to_integer(),
  mcp_enabled: System.get_env("DARWIN_MCP_SERVER_ENABLED", "false") == "true",
  self_rag_enabled: System.get_env("DARWIN_SELF_RAG_ENABLED", "false") == "true",
  espl_enabled: System.get_env("DARWIN_ESPL_ENABLED", "false") == "true",
  tier2_auto_apply: System.get_env("DARWIN_TIER2_AUTO_APPLY", "false") == "true",
  principle_semantic_check:
    System.get_env("DARWIN_PRINCIPLE_SEMANTIC_CHECK", "false") == "true",
  project_root: System.get_env("PROJECT_ROOT", "/Users/alexlee/projects/ai-agent-system"),
  mlx_base_url: System.get_env("MLX_BASE_URL", "http://localhost:11434"),
  embed_model: "qwen3-embed-0.6b",
  embed_dim: 1024
