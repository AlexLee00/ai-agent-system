defmodule TeamJay.Teams.InvestmentShadowSupervisor do
  use Supervisor

  @investment_agents [
    %{name: :luna_commander, label: "ai.investment.commander"},
    %{name: :luna_marketdata_mcp, label: "ai.luna.marketdata-mcp"},
    %{name: :luna_elixir_supervisor, label: "ai.elixir.supervisor"},
    %{name: :luna_runtime_autopilot, label: "ai.investment.runtime-autopilot"},
    %{name: :luna_ops_scheduler, label: "ai.luna.ops-scheduler"},
    %{name: :luna_tradingview_ws, label: "ai.luna.tradingview-ws"}
  ]

  def start_link(opts \\ []) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    children =
      Enum.map(@investment_agents, fn agent ->
        {Jay.Core.Agents.LaunchdShadowAgent,
         name: agent.name,
         team: :investment,
         label: agent.label,
         required: Map.get(agent, :required, true)}
      end)

    Supervisor.init(children, strategy: :one_for_one, max_restarts: 10, max_seconds: 60)
  end
end
