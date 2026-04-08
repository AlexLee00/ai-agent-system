defmodule TeamJay.Teams.PlatformShadowSupervisor do
  use Supervisor

  @platform_agents [
    %{name: :darwin_orchestrator, label: "ai.orchestrator"},
    %{name: :hub_resource_api, label: "ai.hub.resource-api"}
  ]

  def start_link(opts \\ []) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    children =
      Enum.map(@platform_agents, fn agent ->
        {TeamJay.Agents.LaunchdShadowAgent, name: agent.name, team: :platform, label: agent.label}
      end)

    Supervisor.init(children, strategy: :one_for_one, max_restarts: 3, max_seconds: 60)
  end
end
