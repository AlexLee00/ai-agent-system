defmodule TeamJay.Teams.SkaSupervisor do
  @moduledoc """
  스카팀 메인 Supervisor

  자기 복구 Loop 1: FailureTracker (실패 수집 + 분류 + 자동 복구)
  자기 복구 Loop 2: ParsingGuard + SelectorManager (3단계 파싱 폴백)
  Orchestrator: 일일 브리핑 + Phase 전환 관리

  → PortAgent 스크립트들 위에서 네이티브 Elixir GenServer가 함께 실행됨!
  """

  use Supervisor

  @ska_agents [
    %{name: :andy, script: "dist/ts-runtime/bots/reservation/auto/monitors/naver-monitor.js", schedule: {:interval, 300_000}},
    %{name: :jimmy, script: "dist/ts-runtime/bots/reservation/auto/monitors/pickko-kiosk-monitor.js", schedule: {:interval, 300_000}},
    %{name: :eve, script: "bots/ska/scripts/eve.js", schedule: {:interval, 3_600_000}},
    %{name: :eve_crawl, script: "bots/ska/scripts/eve-crawl.js", schedule: {:interval, 3_600_000}},
    %{name: :ska_etl, script: "bots/ska/scripts/etl.js", schedule: nil},
    %{name: :rebecca, script: "bots/ska/scripts/rebecca.js", schedule: {:interval, 3_600_000}},
    %{name: :forecast_daily, script: "bots/ska/scripts/forecast.js --daily", schedule: nil},
    %{name: :forecast_weekly, script: "bots/ska/scripts/forecast.js --weekly", schedule: {:interval, 86_400_000}},
    %{name: :forecast_monthly, script: "bots/ska/scripts/forecast.js --monthly", schedule: {:interval, 86_400_000}},
    %{name: :pickko_daily_audit, script: "bots/ska/scripts/pickko-daily-audit.js", schedule: {:interval, 86_400_000}},
    %{name: :pickko_daily_summary, script: "bots/ska/scripts/pickko-daily-summary.js", schedule: {:interval, 86_400_000}},
    %{name: :pickko_verify, script: "bots/ska/scripts/pickko-verify.js", schedule: {:interval, 86_400_000}},
    %{name: :today_audit, script: "bots/ska/scripts/today-audit.js", schedule: {:interval, 86_400_000}},
    # launchd가 canonical owner인 상시/주기 서비스는 PortAgent 목록에서 제외한다.
    %{name: :log_report, script: "bots/ska/scripts/log-report.js", schedule: {:interval, 86_400_000}},
    %{name: :log_rotate, script: "bots/ska/scripts/log-rotate.js", schedule: {:interval, 86_400_000}},
    %{name: :db_backup, script: "bots/ska/scripts/db-backup.js", schedule: {:interval, 86_400_000}}
  ]

  def start_link(opts \\ []) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    # 네이티브 Elixir GenServer (자기 복구 루프!)
    native_children = [
      TeamJay.Ska.FailureTracker,
      TeamJay.Ska.SelectorManager,
      TeamJay.Ska.ParsingGuard,
      TeamJay.Ska.Orchestrator
    ]

    # PortAgent 래퍼 (Node.js 스크립트!)
    port_children =
      Enum.map(@ska_agents, fn agent ->
        {TeamJay.Agents.PortAgent,
         name: agent.name, team: :ska, script: agent.script, schedule: agent.schedule}
      end)

    children = native_children ++ port_children

    Supervisor.init(children, strategy: :one_for_one, max_restarts: 10, max_seconds: 60)
  end
end
