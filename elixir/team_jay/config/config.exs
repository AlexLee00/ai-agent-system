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
    {"0 8 * * *", {TeamJay.Teams.InvestmentScheduler, :run_prescreen_domestic, []}},
    {"0 21 * * *", {TeamJay.Teams.InvestmentScheduler, :run_prescreen_overseas, []}},
    # market-alert-* 는 launchd가 KST 기준으로 이미 담당한다.
    # Quantum cron은 UTC 기준이어서 중복/오발송 위험이 있어 제외한다.
    {"0 8 * * *", {TeamJay.Teams.InvestmentScheduler, :run_reporter, []}},
    {"0 21 * * *", {TeamJay.Teams.InvestmentScheduler, :run_daily_feedback, []}},
    # ─── CODEX_LUNA_OPS_TRANSITION 신규 (UTC 기준) ───────────────
    # Scout: 06:30 KST = 21:30 UTC 전날, 18:30 KST = 09:30 UTC
    {"30 21 * * *", {TeamJay.Teams.InvestmentScheduler, :run_scout, []}},
    {"30 9 * * *", {TeamJay.Teams.InvestmentScheduler, :run_scout, []}},
    # 국내장: 09:00~15:30 KST = 00:00~06:30 UTC
    {"0,30 0-6 * * *", {TeamJay.Teams.InvestmentScheduler, :run_domestic, []}},
    {"0,30 0-6 * * *", {TeamJay.Teams.InvestmentScheduler, :run_domestic_validation, []}},
    # 해외장: 22:30 KST = 13:30 UTC, 05:00 KST = 20:00 UTC
    {"30 13 * * *", {TeamJay.Teams.InvestmentScheduler, :run_overseas, []}},
    {"0,30 14-19 * * *", {TeamJay.Teams.InvestmentScheduler, :run_overseas, []}},
    {"0 20 * * *", {TeamJay.Teams.InvestmentScheduler, :run_overseas, []}},
    {"30 13 * * *", {TeamJay.Teams.InvestmentScheduler, :run_overseas_validation, []}},
    {"0,30 14-19 * * *", {TeamJay.Teams.InvestmentScheduler, :run_overseas_validation, []}},
    {"0 20 * * *", {TeamJay.Teams.InvestmentScheduler, :run_overseas_validation, []}},
    # ─── 다윈팀 연구 스케줄 (UTC 기준) ─────────────────────────────
    # 논문 스캔: 06:00 KST = 21:00 UTC (전날)
    {"0 21 * * *", {Jay.Core.Agents.PortAgent, :run, [:darwin_scanner]}},
    # 연구 태스크 실행: 07:00 KST = 22:00 UTC (전날)
    {"0 22 * * *", {Jay.Core.Agents.PortAgent, :run, [:darwin_task_runner]}}
  ]
