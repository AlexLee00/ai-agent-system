import Config

config :luna,
  # 기존 Kill Switch
  v2_enabled: System.get_env("LUNA_V2_ENABLED") == "true",
  mapek_enabled: System.get_env("LUNA_MAPEK_ENABLED") == "true",
  commander_enabled: System.get_env("LUNA_COMMANDER_ENABLED") == "true",
  shadow_mode: System.get_env("LUNA_LLM_HUB_SHADOW", "false") == "true",
  hub_routing: System.get_env("LUNA_LLM_HUB_ENABLED", "false") == "true",
  http_port: String.to_integer(System.get_env("LUNA_HTTP_PORT", "4030")),

  # Phase 5 LIVE 전환 Kill Switch
  auto_mode: System.get_env("LUNA_AUTO_MODE", "false") == "true",
  live_crypto: System.get_env("LUNA_LIVE_CRYPTO", "true") == "true",
  live_domestic: System.get_env("LUNA_LIVE_DOMESTIC", "false") == "true",
  live_overseas: System.get_env("LUNA_LIVE_OVERSEAS", "false") == "true",

  # Phase 4 구성요소 Kill Switch
  validation_enabled: System.get_env("LUNA_VALIDATION_ENABLED", "false") == "true",
  prediction_enabled: System.get_env("LUNA_PREDICTION_ENABLED", "false") == "true",
  rag_enabled: System.get_env("LUNA_RAG_ENABLED", "false") == "true",
  position_watch_enabled: System.get_env("LUNA_POSITION_WATCH_ENABLED", "true") == "true",
  position_watch_interval_ms:
    String.to_integer(System.get_env("LUNA_POSITION_WATCH_INTERVAL_MS", "60000")),
  position_watch_idle_ms:
    String.to_integer(System.get_env("LUNA_POSITION_WATCH_IDLE_MS", "60000")),
  position_watch_crypto_realtime_ms:
    String.to_integer(System.get_env("LUNA_POSITION_WATCH_CRYPTO_REALTIME_MS", "15000")),
  position_watch_domestic_realtime_ms:
    String.to_integer(
      System.get_env(
        "LUNA_POSITION_WATCH_DOMESTIC_REALTIME_MS",
        System.get_env("LUNA_POSITION_WATCH_STOCK_REALTIME_MS", "15000")
      )
    ),
  position_watch_overseas_realtime_ms:
    String.to_integer(
      System.get_env(
        "LUNA_POSITION_WATCH_OVERSEAS_REALTIME_MS",
        System.get_env("LUNA_POSITION_WATCH_STOCK_REALTIME_MS", "15000")
      )
    ),
  position_watch_stock_realtime_ms:
    String.to_integer(System.get_env("LUNA_POSITION_WATCH_STOCK_REALTIME_MS", "15000")),
  position_watch_stock_offhours_ms:
    String.to_integer(System.get_env("LUNA_POSITION_WATCH_STOCK_OFFHOURS_MS", "300000")),
  position_watch_fallback_ms:
    String.to_integer(System.get_env("LUNA_POSITION_WATCH_FALLBACK_MS", "60000")),
  position_watch_stop_loss_pct:
    String.to_float(System.get_env("LUNA_POSITION_WATCH_STOP_LOSS_PCT", "0.05")),
  position_watch_adjust_gain_pct:
    String.to_float(System.get_env("LUNA_POSITION_WATCH_ADJUST_GAIN_PCT", "0.10")),
  position_watch_stale_minutes:
    String.to_integer(System.get_env("LUNA_POSITION_WATCH_STALE_MINUTES", "120")),
  position_watch_crypto_dust_usdt:
    String.to_float(System.get_env("LUNA_POSITION_WATCH_CRYPTO_DUST_USDT", "10.0")),
  position_watch_tv_enabled: System.get_env("LUNA_POSITION_WATCH_TV_ENABLED", "true") == "true",
  position_watch_tv_base_url:
    System.get_env("LUNA_POSITION_WATCH_TV_BASE_URL", "http://127.0.0.1:8083"),
  position_watch_tv_timeframes:
    String.split(System.get_env("LUNA_POSITION_WATCH_TV_TIMEFRAMES", "1h,4h"), ",", trim: true),
  position_watch_tv_stale_ms:
    String.to_integer(System.get_env("LUNA_POSITION_WATCH_TV_STALE_MS", "180000")),
  position_watch_active_backtest_enabled:
    System.get_env("LUNA_POSITION_WATCH_ACTIVE_BACKTEST_ENABLED", "true") == "true",
  position_watch_active_backtest_days:
    String.to_integer(System.get_env("LUNA_POSITION_WATCH_ACTIVE_BACKTEST_DAYS", "30")),
  position_watch_active_backtest_cooldown_minutes:
    String.to_integer(
      System.get_env("LUNA_POSITION_WATCH_ACTIVE_BACKTEST_COOLDOWN_MINUTES", "30")
    ),
  position_watch_active_backtest_max_per_tick:
    String.to_integer(System.get_env("LUNA_POSITION_WATCH_ACTIVE_BACKTEST_MAX_PER_TICK", "2")),
  position_watch_backtest_drift_enabled:
    System.get_env("LUNA_POSITION_WATCH_BACKTEST_DRIFT_ENABLED", "true") == "true",
  position_watch_backtest_drift_min_trades:
    String.to_integer(System.get_env("LUNA_POSITION_WATCH_BACKTEST_DRIFT_MIN_TRADES", "4")),
  position_watch_backtest_drift_adjust_sharpe_drop:
    String.to_float(System.get_env("LUNA_POSITION_WATCH_BACKTEST_DRIFT_ADJUST_SHARPE_DROP", "0.75")),
  position_watch_backtest_drift_exit_sharpe_drop:
    String.to_float(System.get_env("LUNA_POSITION_WATCH_BACKTEST_DRIFT_EXIT_SHARPE_DROP", "1.5")),
  position_watch_backtest_drift_adjust_return_drop_pct:
    String.to_float(System.get_env("LUNA_POSITION_WATCH_BACKTEST_DRIFT_ADJUST_RETURN_DROP_PCT", "5.0")),
  position_watch_backtest_drift_exit_return_drop_pct:
    String.to_float(System.get_env("LUNA_POSITION_WATCH_BACKTEST_DRIFT_EXIT_RETURN_DROP_PCT", "10.0")),
  position_watch_strategy_exit_enabled:
    System.get_env("LUNA_POSITION_WATCH_STRATEGY_EXIT_ENABLED", "true") == "true",
  position_watch_strategy_exit_cooldown_minutes:
    String.to_integer(System.get_env("LUNA_POSITION_WATCH_STRATEGY_EXIT_COOLDOWN_MINUTES", "30")),
  position_watch_strategy_exit_max_per_tick:
    String.to_integer(System.get_env("LUNA_POSITION_WATCH_STRATEGY_EXIT_MAX_PER_TICK", "2")),
  position_watch_reevaluation_enabled:
    System.get_env("LUNA_POSITION_WATCH_REEVALUATION_ENABLED", "true") == "true",
  position_watch_reevaluation_cooldown_minutes:
    String.to_integer(System.get_env("LUNA_POSITION_WATCH_REEVALUATION_COOLDOWN_MINUTES", "10")),
  position_watch_reevaluation_max_per_tick:
    String.to_integer(System.get_env("LUNA_POSITION_WATCH_REEVALUATION_MAX_PER_TICK", "3")),
  layer1_working_memory_enabled:
    System.get_env("LUNA_AGENT_LAYER1_WORKING_MEMORY_ENABLED", "false") == "true",
  layer1_working_memory_ttl_ms:
    String.to_integer(System.get_env("LUNA_AGENT_LAYER1_WORKING_MEMORY_TTL_MS", "900000")),
  layer1_working_memory_prune_interval_ms:
    String.to_integer(System.get_env("LUNA_AGENT_LAYER1_WORKING_MEMORY_PRUNE_INTERVAL_MS", "60000")),

  # Wave 1 final closure: Elixir shadow/parallel agents are enabled by default
  # only after the V2 supervisor itself is enabled.
  elixir_agents_enabled: System.get_env("LUNA_ELIXIR_AGENTS_ENABLED", "true") != "false",
  elixir_agents_parallel_ts: System.get_env("LUNA_ELIXIR_AGENTS_PARALLEL_TS", "true") != "false"

config :luna, Jay.Core.Repo,
  database: System.get_env("PG_DATABASE", "jay"),
  username: System.get_env("PG_USER", "jay"),
  password: System.get_env("PG_PASSWORD", ""),
  hostname: System.get_env("PG_HOST", "localhost"),
  port: String.to_integer(System.get_env("PG_PORT", "5432")),
  pool_size: 2,
  log: false
