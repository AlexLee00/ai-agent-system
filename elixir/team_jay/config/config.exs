import Config

config :team_jay,
  ecto_repos: [Jay.Core.Repo]

config :team_jay, Jay.Core.Repo,
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

# Phase 3: 코덱스 자동 실행 (true = 마스터 승인 없이 자동 실행)
config :team_jay, :codex_auto_execute, true

import_config "#{Mix.env()}.exs"

# Darwin V2 설정 — 런타임에 System.get_env로 직접 읽음 (Darwin.V2.Config 참조)
config :darwin,
  anthropic_api_key: System.get_env("ANTHROPIC_API_KEY"),
  llm_daily_budget_usd:
    System.get_env("DARWIN_LLM_DAILY_BUDGET_USD", "10.0") |> String.to_float(),
  v2_enabled: System.get_env("DARWIN_V2_ENABLED", "false") == "true",
  shadow_mode: System.get_env("DARWIN_SHADOW_MODE", "true") == "true",
  kill_switch: System.get_env("DARWIN_KILL_SWITCH", "true") == "true",
  http_port: System.get_env("DARWIN_HTTP_PORT", "8180") |> String.to_integer()


config :team_jay, Jay.Core.Scheduler,
  jobs: [
    # ─── 제이팀 성장 사이클 ──────────────────────────────────
    # 06:30 KST = 21:30 UTC 전날 (cron은 UTC 기준)
    {"30 21 * * *", {TeamJay.Jay.GrowthCycle, :run_cycle, []}},
    # 주간 리포트 — 매주 월요일 07:30 KST = 22:30 UTC 일요일
    {"30 22 * * 0", {TeamJay.Jay.WeeklyReport, :run, []}},
    # 시그마 피드백 효과 측정 (매일 22:00 KST = 13:00 UTC)
    {"0 13 * * *", {TeamJay.Jay.Sigma.Feedback, :ensure_tables, []}},
    # ─── 기존 스케줄 ────────────────────────────────────────
    {"0 * * * *", {Jay.Core.Agents.PortAgent, :run, [:ska_etl]}},
    {"*/30 * * * *", {Jay.Core.Diagnostics, :publish_shadow_report, []}},
    {"0 6 * * *", {Jay.Core.Agents.PortAgent, :run, [:forecast_daily]}},
    {"0 9 * * *", {Jay.Core.Agents.PortAgent, :run, [:dexter_daily]}},
    {"0 10 * * 1", {Jay.Core.Agents.PortAgent, :run, [:steward_weekly]}},
    {"0 8 * * *", {TeamJay.Teams.InvestmentScheduler, :run_prescreen_domestic, []}},
    {"0 21 * * *", {TeamJay.Teams.InvestmentScheduler, :run_prescreen_overseas, []}},
    {"0 9 * * *", {TeamJay.Teams.InvestmentScheduler, :run_market_alert_crypto_daily, []}},
    {"0 9 * * *", {TeamJay.Teams.InvestmentScheduler, :run_market_alert_domestic_open, []}},
    {"30 15 * * *", {TeamJay.Teams.InvestmentScheduler, :run_market_alert_domestic_close, []}},
    {"30 23 * * *", {TeamJay.Teams.InvestmentScheduler, :run_market_alert_overseas_open, []}},
    {"0 6 * * *", {TeamJay.Teams.InvestmentScheduler, :run_market_alert_overseas_close, []}},
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
