defmodule TeamJay.Teams.WorkerShadowSupervisor do
  use Supervisor

  @worker_agents []

  def start_link(opts \\ []) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    children =
      Enum.map(@worker_agents, fn agent ->
        {TeamJay.Agents.LaunchdShadowAgent,
         name: agent.name,
         team: :worker,
         label: agent.label,
         required: Map.get(agent, :required, true)}
      end)

    Supervisor.init(children, strategy: :one_for_one, max_restarts: 5, max_seconds: 60)
  end
end
