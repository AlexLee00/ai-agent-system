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

dashboard_port =
  System.get_env("TEAM_JAY_DASHBOARD_PORT") ||
    System.get_env("DASHBOARD_PORT") ||
    "7787"

dashboard_secret_key_base =
  System.get_env("TEAM_JAY_DASHBOARD_SECRET_KEY_BASE") ||
    System.get_env("DASHBOARD_SECRET_KEY_BASE") ||
    "teamjay_dashboard_dev_key_changeme_in_prod_xxxxxxxxxxxxxxxxxxxxxxxx"

dashboard_server_value =
  System.get_env("TEAM_JAY_DASHBOARD_SERVER", "true")
  |> String.trim()
  |> String.downcase()

dashboard_server? = dashboard_server_value in ["1", "true", "yes", "on"]

# Phase A: LiveView 대시보드 (http://localhost:7787)
config :team_jay, TeamJay.Dashboard.Endpoint,
  adapter: Bandit.PhoenixAdapter,
  http: [port: String.to_integer(dashboard_port)],
  server: dashboard_server?,
  check_origin: [
    "//localhost:#{dashboard_port}",
    "//127.0.0.1:#{dashboard_port}",
    "//[::1]:#{dashboard_port}"
  ],
  # 로컬 내부 도구용 — 운영 배포 시 환경변수로 교체 필수
  secret_key_base: dashboard_secret_key_base,
  live_view: [signing_salt: "tvdashboard"],
  pubsub_server: TeamJay.PubSub

config :team_jay, :dashboard_pubsub, TeamJay.PubSub
config :jay_core, :dashboard_pubsub, TeamJay.PubSub

# Phase 3: 코덱스 자동 실행 (true = 마스터 승인 없이 자동 실행)
config :team_jay, :codex_auto_execute, true

# cycle #53 M2: Tailwind JIT + esbuild assets pipeline
config :tailwind,
  version: "3.4.3",
  default: [
    args: ~w(
      --config=tailwind.config.js
      --input=css/app.css
      --output=../priv/static/dashboard.css
    ),
    cd: Path.expand("../assets", __DIR__)
  ]

config :esbuild,
  version: "0.21.5",
  default: [
    args: ~w(js/app.js --bundle --target=es2017 --outdir=../priv/static),
    cd: Path.expand("../assets", __DIR__),
    env: %{"NODE_PATH" => Path.expand("../deps", __DIR__)}
  ]

import_config "#{Mix.env()}.exs"

config :team_jay, Jay.Core.Scheduler,
  jobs: [
    # ─── 기존 스케줄 ────────────────────────────────────────
    {"*/30 * * * *", {Jay.Core.Diagnostics, :publish_shadow_report, []}}
    # launchd가 canonical owner인 wall-clock/periodic 작업은 Quantum에서 중복 실행하지 않는다.
    # - ai.ska.etl
    # - ai.ska.forecast-daily
    # - ai.claude.dexter.daily
    # - ai.steward.weekly
    # 투자팀 wall-clock 스케줄은 launchd가 KST 기준으로 전담한다.
    # Quantum에 같은 작업을 중복 등록하면 UTC/KST 혼선과 중복 실행이 생기므로 제외한다.
    # Darwin weekly cadence는 launchd(ai.darwin.weekly.autonomous / weekly-review / weekly-ops-report)가 canonical owner다.
    # 과거 darwin_scanner / darwin_task_runner Quantum cron은 PortAgent 정의도 없는 레거시라 제거한다.
  ]
