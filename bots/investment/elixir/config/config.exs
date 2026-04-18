import Config

config :luna,
  v2_enabled:       System.get_env("LUNA_V2_ENABLED") == "true",
  mapek_enabled:    System.get_env("LUNA_MAPEK_ENABLED") == "true",
  commander_enabled: System.get_env("LUNA_COMMANDER_ENABLED") == "true",
  shadow_mode:      System.get_env("LUNA_LLM_HUB_SHADOW", "false") == "true",
  hub_routing:      System.get_env("LUNA_LLM_HUB_ENABLED", "false") == "true",
  http_port:        String.to_integer(System.get_env("LUNA_HTTP_PORT", "4030"))

config :luna, Jay.Core.Repo,
  database:  System.get_env("PG_DATABASE", "jay"),
  username:  System.get_env("PG_USER", "jay"),
  password:  System.get_env("PG_PASSWORD", ""),
  hostname:  System.get_env("PG_HOST", "localhost"),
  port:      String.to_integer(System.get_env("PG_PORT", "5432")),
  pool_size: 2,
  log: false
