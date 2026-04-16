defmodule TeamJay.Teams.PlatformShadowSupervisor do
  use Supervisor

  @platform_agents []

  def start_link(opts \\ []) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    children =
      Enum.map(@platform_agents, fn agent ->
        {TeamJay.Agents.LaunchdShadowAgent,
         name: agent.name,
         team: :platform,
         label: agent.label,
         required: Map.get(agent, :required, true)}
      end)

    Supervisor.init(children, strategy: :one_for_one, max_restarts: 3, max_seconds: 60)
  end
end
