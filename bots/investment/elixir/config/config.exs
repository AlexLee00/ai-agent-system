import Config

config :luna,
  # 기존 Kill Switch
  v2_enabled:        System.get_env("LUNA_V2_ENABLED") == "true",
  mapek_enabled:     System.get_env("LUNA_MAPEK_ENABLED") == "true",
  commander_enabled: System.get_env("LUNA_COMMANDER_ENABLED") == "true",
  shadow_mode:       System.get_env("LUNA_LLM_HUB_SHADOW", "false") == "true",
  hub_routing:       System.get_env("LUNA_LLM_HUB_ENABLED", "false") == "true",
  http_port:         String.to_integer(System.get_env("LUNA_HTTP_PORT", "4030")),

  # Phase 5 LIVE 전환 Kill Switch
  auto_mode:         System.get_env("LUNA_AUTO_MODE", "false") == "true",
  live_crypto:       System.get_env("LUNA_LIVE_CRYPTO", "true") == "true",
  live_domestic:     System.get_env("LUNA_LIVE_DOMESTIC", "false") == "true",
  live_overseas:     System.get_env("LUNA_LIVE_OVERSEAS", "false") == "true",

  # Phase 4 구성요소 Kill Switch
  validation_enabled: System.get_env("LUNA_VALIDATION_ENABLED", "false") == "true",
  prediction_enabled: System.get_env("LUNA_PREDICTION_ENABLED", "false") == "true",
  rag_enabled:        System.get_env("LUNA_RAG_ENABLED", "false") == "true"

config :luna, Jay.Core.Repo,
  database:  System.get_env("PG_DATABASE", "jay"),
  username:  System.get_env("PG_USER", "jay"),
  password:  System.get_env("PG_PASSWORD", ""),
  hostname:  System.get_env("PG_HOST", "localhost"),
  port:      String.to_integer(System.get_env("PG_PORT", "5432")),
  pool_size: 2,
  log: false
