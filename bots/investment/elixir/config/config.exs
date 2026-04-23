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
  rag_enabled:        System.get_env("LUNA_RAG_ENABLED", "false") == "true",
  position_watch_enabled: System.get_env("LUNA_POSITION_WATCH_ENABLED", "true") == "true",
  position_watch_interval_ms: String.to_integer(System.get_env("LUNA_POSITION_WATCH_INTERVAL_MS", "60000")),
  position_watch_stop_loss_pct: String.to_float(System.get_env("LUNA_POSITION_WATCH_STOP_LOSS_PCT", "0.05")),
  position_watch_adjust_gain_pct: String.to_float(System.get_env("LUNA_POSITION_WATCH_ADJUST_GAIN_PCT", "0.10")),
  position_watch_stale_minutes: String.to_integer(System.get_env("LUNA_POSITION_WATCH_STALE_MINUTES", "120")),
  position_watch_tv_enabled: System.get_env("LUNA_POSITION_WATCH_TV_ENABLED", "true") == "true",
  position_watch_tv_base_url: System.get_env("LUNA_POSITION_WATCH_TV_BASE_URL", "http://127.0.0.1:8083"),
  position_watch_tv_timeframes: String.split(System.get_env("LUNA_POSITION_WATCH_TV_TIMEFRAMES", "1h,4h"), ",", trim: true),
  position_watch_tv_stale_ms: String.to_integer(System.get_env("LUNA_POSITION_WATCH_TV_STALE_MS", "180000"))

config :luna, Jay.Core.Repo,
  database:  System.get_env("PG_DATABASE", "jay"),
  username:  System.get_env("PG_USER", "jay"),
  password:  System.get_env("PG_PASSWORD", ""),
  hostname:  System.get_env("PG_HOST", "localhost"),
  port:      String.to_integer(System.get_env("PG_PORT", "5432")),
  pool_size: 2,
  log: false
