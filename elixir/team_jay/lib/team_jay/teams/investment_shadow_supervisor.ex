defmodule TeamJay.Teams.InvestmentShadowSupervisor do
  use Supervisor

  @investment_agents [
    %{name: :luna_commander, label: "ai.investment.commander"},
    %{name: :luna_domestic, label: "ai.investment.domestic"},
    %{name: :luna_domestic_validation, label: "ai.investment.domestic.validation"},
    %{name: :luna_overseas, label: "ai.investment.overseas"},
    %{name: :luna_overseas_validation, label: "ai.investment.overseas.validation"},
    %{name: :luna_crypto, label: "ai.investment.crypto"},
    %{name: :luna_crypto_validation, label: "ai.investment.crypto.validation"},
    %{name: :argos_shadow, label: "ai.investment.argos"},
    %{name: :reporter_shadow, label: "ai.investment.reporter"},
    %{name: :invest_health_check, label: "ai.investment.health-check"},
    %{name: :unrealized_pnl_shadow, label: "ai.investment.unrealized-pnl"},
    %{name: :prescreen_domestic, label: "ai.investment.prescreen-domestic"},
    %{name: :prescreen_overseas, label: "ai.investment.prescreen-overseas"},
    %{name: :market_alert_domestic_open, label: "ai.investment.market-alert-domestic-open"},
    %{name: :market_alert_domestic_close, label: "ai.investment.market-alert-domestic-close"},
    %{name: :market_alert_overseas_open, label: "ai.investment.market-alert-overseas-open"},
    %{name: :market_alert_overseas_close, label: "ai.investment.market-alert-overseas-close"},
    %{name: :market_alert_crypto_daily, label: "ai.investment.market-alert-crypto-daily"}
  ]

  def start_link(opts \\ []) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    children =
      Enum.map(@investment_agents, fn agent ->
        {TeamJay.Agents.LaunchdShadowAgent, name: agent.name, team: :investment, label: agent.label}
      end)

    Supervisor.init(children, strategy: :one_for_one, max_restarts: 10, max_seconds: 60)
  end
end
