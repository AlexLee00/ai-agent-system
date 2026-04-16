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
    # launchd가 canonical owner인 모니터는 PortAgent에서 중복 실행하지 않는다.
    %{name: :eve, script: "bots/ska/scripts/eve.js", schedule: {:interval, 3_600_000}},
    %{name: :eve_crawl, script: "bots/ska/scripts/eve-crawl.js", schedule: {:interval, 3_600_000}},
    %{
      name: :ska_etl,
      script: "cd /Users/alexlee/projects/ai-agent-system && /Users/alexlee/projects/ai-agent-system/bots/ska/venv/bin/python /Users/alexlee/projects/ai-agent-system/bots/ska/src/etl.py",
      runner: {:shell, "/bin/bash"},
      schedule: nil
    },
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
    # 네이티브 Elixir GenServer (자기 복구 루프 + Phase 1 네이티브!)
    native_children = [
      # Loop 1: 실패 수집 + 분류
      TeamJay.Ska.FailureTracker,
      # Loop 2: 파싱 안정화
      TeamJay.Ska.SelectorManager,
      TeamJay.Ska.ParsingGuard,
      # 오케스트레이터 (Phase 전환)
      TeamJay.Ska.Orchestrator,
      # Phase 1: 네이버 네이티브
      TeamJay.Ska.Naver.NaverMonitor,
      TeamJay.Ska.Naver.NaverSession,
      TeamJay.Ska.Naver.NaverRecovery,
      # Phase 1: 픽코 네이티브
      TeamJay.Ska.Pickko.PickkoMonitor,
      TeamJay.Ska.Pickko.PickkoAudit,
      # Phase 1: 키오스크
      TeamJay.Ska.Kiosk.KioskAgent,
      TeamJay.Ska.Kiosk.KioskBlockFlow,
      # Phase 1: PortBridge
      TeamJay.Ska.PortBridge.NaverPort,
      TeamJay.Ska.PortBridge.PickkoPort,
      # Analytics (Phase 4)
      TeamJay.Ska.Analytics.RevenueTracker,
      TeamJay.Ska.Analytics.Forecast,
      TeamJay.Ska.Analytics.Dashboard,
      TeamJay.Ska.Analytics.MarketingConnector,
      TeamJay.Ska.Analytics.OperationsRag
    ]

    # PortAgent 래퍼 (Node.js 스크립트!)
    port_children =
      Enum.map(@ska_agents, fn agent ->
        {TeamJay.Agents.PortAgent,
         name: agent.name,
         team: :ska,
         script: agent.script,
         runner: Map.get(agent, :runner, :node),
         schedule: agent.schedule}
      end)

    children = native_children ++ port_children

    Supervisor.init(children, strategy: :one_for_one, max_restarts: 10, max_seconds: 60)
  end
end
