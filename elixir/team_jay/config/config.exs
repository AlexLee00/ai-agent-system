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

config :team_jay,
  repo_root: System.get_env("REPO_ROOT", "/Users/alexlee/projects/ai-agent-system")

config :team_jay, TeamJay.Scheduler,
  jobs: [
    {"0 * * * *", {TeamJay.Agents.PortAgent, :run, [:ska_etl]}},
    {"*/30 * * * *", {TeamJay.Diagnostics, :publish_shadow_report, []}},
    {"0 6 * * *", {TeamJay.Agents.PortAgent, :run, [:forecast_daily]}},
    {"0 9 * * *", {TeamJay.Agents.PortAgent, :run, [:dexter_daily]}},
    {"0 10 * * 1", {TeamJay.Agents.PortAgent, :run, [:steward_weekly]}}
  ]
