defmodule TeamJay.Teams.InvestmentSupervisor do
  use Supervisor

  @moduledoc """
  루나팀 PortAgent 전환용 스캐폴드.

  주의:
  - 아직 application.ex에는 연결하지 않는다.
  - calendar 기반 작업은 현재 PortAgent가 wall-clock 스케줄을 직접 지원하지 않아
    `schedule: nil`로 남기고 추후 TeamJay.Scheduler 또는 별도 래퍼에서 연결한다.
  """

  @investment_agents [
    # ai.investment.commander launchd 상시 서비스가 canonical owner다.
    # PortAgent 목록에서는 완전히 제외해 중복 실행/false-failure를 막는다.
    %{name: :luna_crypto, script: "bots/investment/markets/crypto.ts", schedule: {:interval, 900_000}},
    %{name: :luna_crypto_validation, script: "bots/investment/markets/crypto.ts --validation", schedule: {:interval, 900_000}},
    %{name: :luna_domestic, script: "bots/investment/markets/domestic.ts", schedule: {:interval, 1_800_000}},
    %{name: :luna_domestic_validation, script: "bots/investment/markets/domestic.ts --validation", schedule: {:interval, 1_800_000}},
    %{name: :luna_overseas, script: "bots/investment/markets/overseas.ts", schedule: {:interval, 1_800_000}},
    %{name: :luna_overseas_validation, script: "bots/investment/markets/overseas.ts --validation", schedule: {:interval, 1_800_000}},
    %{name: :argos, script: "bots/investment/team/argos.ts", schedule: {:interval, 3_600_000}},
    %{name: :invest_health_check, script: "bots/investment/scripts/health-check.ts", schedule: {:interval, 600_000}},
    %{name: :unrealized_pnl, script: "bots/investment/scripts/update-unrealized-pnl.ts", schedule: {:interval, 300_000}},
    %{name: :prescreen_domestic, script: "bots/investment/scripts/pre-market-screen.ts --market=domestic", schedule: nil},
    %{name: :prescreen_overseas, script: "bots/investment/scripts/pre-market-screen.ts --market=overseas", schedule: nil},
    %{name: :market_alert_domestic_open, script: "bots/investment/scripts/market-alert.ts --market=domestic --event=open", schedule: nil},
    %{name: :market_alert_domestic_close, script: "bots/investment/scripts/market-alert.ts --market=domestic --event=close", schedule: nil},
    %{name: :market_alert_overseas_open, script: "bots/investment/scripts/market-alert.ts --market=overseas --event=open", schedule: nil},
    %{name: :market_alert_overseas_close, script: "bots/investment/scripts/market-alert.ts --market=overseas --event=close", schedule: nil},
    %{name: :market_alert_crypto_daily, script: "bots/investment/scripts/market-alert.ts --market=crypto --event=daily", schedule: nil},
    %{name: :reporter, script: "bots/investment/team/reporter.ts --telegram", schedule: nil},
    %{name: :daily_feedback, script: "bots/investment/scripts/daily-trade-feedback.ts", schedule: nil}
  ]

  def start_link(opts \\ []) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    children =
      Enum.map(@investment_agents, fn agent ->
        {TeamJay.Agents.PortAgent,
         name: agent.name, team: :investment, script: agent.script, schedule: agent.schedule}
      end)

    Supervisor.init(children, strategy: :one_for_one, max_restarts: 10, max_seconds: 60)
  end
end
