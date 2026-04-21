import Config

config :team_jay,
  ecto_repos: [Jay.Core.Repo]

config :team_jay, Jay.Core.Repo,
  database: System.get_env("TEAM_JAY_DB_NAME", "jay"),
  username: System.get_env("TEAM_JAY_DB_USER", "alexlee"),
  password: System.get_env("TEAM_JAY_DB_PASS"),
  hostname: System.get_env("TEAM_JAY_DB_HOST", "localhost"),
  port: String.to_integer(System.get_env("TEAM_JAY_DB_PORT", "5432")),
  pool_size: String.to_integer(System.get_env("TEAM_JAY_DB_POOL_SIZE", "5")),
  types: Jay.Core.PostgresTypes

config :team_jay,
  hub_url: System.get_env("TEAM_JAY_HUB_URL", "http://127.0.0.1:7788"),
  hub_token: System.get_env("TEAM_JAY_HUB_TOKEN"),
  pg_notify_channel: System.get_env("TEAM_JAY_EVENT_CHANNEL", "event_lake_insert")

config :team_jay,
  repo_root: System.get_env("REPO_ROOT", "/Users/alexlee/projects/ai-agent-system")

# Phase 3: 코덱스 자동 실행 (true = 마스터 승인 없이 자동 실행)
config :team_jay, :codex_auto_execute, true

import_config "#{Mix.env()}.exs"

config :team_jay, Jay.Core.Scheduler,
  jobs: [
    # ─── 기존 스케줄 ────────────────────────────────────────
    {"0 * * * *", {Jay.Core.Agents.PortAgent, :run, [:ska_etl]}},
    {"*/30 * * * *", {Jay.Core.Diagnostics, :publish_shadow_report, []}},
    {"0 6 * * *", {Jay.Core.Agents.PortAgent, :run, [:forecast_daily]}},
    {"0 9 * * *", {Jay.Core.Agents.PortAgent, :run, [:dexter_daily]}},
    {"0 10 * * 1", {Jay.Core.Agents.PortAgent, :run, [:steward_weekly]}},
    # 투자팀 wall-clock 스케줄은 launchd가 KST 기준으로 전담한다.
    # Quantum에 같은 작업을 중복 등록하면 UTC/KST 혼선과 중복 실행이 생기므로 제외한다.
    # ─── 다윈팀 연구 스케줄 (UTC 기준) ─────────────────────────────
    # 논문 스캔: 06:00 KST = 21:00 UTC (전날)
    {"0 21 * * *", {Jay.Core.Agents.PortAgent, :run, [:darwin_scanner]}},
    # 연구 태스크 실행: 07:00 KST = 22:00 UTC (전날)
    {"0 22 * * *", {Jay.Core.Agents.PortAgent, :run, [:darwin_task_runner]}}
  ]
