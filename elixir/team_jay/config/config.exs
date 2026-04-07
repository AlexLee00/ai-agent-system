import Config

config :team_jay,
  ecto_repos: [TeamJay.Repo]

config :team_jay, TeamJay.Repo,
  database: System.get_env("TEAM_JAY_DB_NAME", "jay"),
  username: System.get_env("TEAM_JAY_DB_USER", "alexlee"),
  password: System.get_env("TEAM_JAY_DB_PASS"),
  hostname: System.get_env("TEAM_JAY_DB_HOST", "localhost"),
  port: String.to_integer(System.get_env("TEAM_JAY_DB_PORT", "5432")),
  pool_size: String.to_integer(System.get_env("TEAM_JAY_DB_POOL_SIZE", "5"))

config :team_jay,
  hub_url: System.get_env("TEAM_JAY_HUB_URL", "http://127.0.0.1:7788"),
  hub_token: System.get_env("TEAM_JAY_HUB_TOKEN"),
  pg_notify_channel: System.get_env("TEAM_JAY_EVENT_CHANNEL", "event_lake_insert")

