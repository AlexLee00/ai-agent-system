defmodule TeamJay.Teams.SkaSupervisor do
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
    children =
      Enum.map(@ska_agents, fn agent ->
        {TeamJay.Agents.PortAgent,
         name: agent.name, team: :ska, script: agent.script, schedule: agent.schedule}
      end)

    Supervisor.init(children, strategy: :one_for_one, max_restarts: 10, max_seconds: 60)
  end
end
