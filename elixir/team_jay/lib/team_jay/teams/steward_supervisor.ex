defmodule TeamJay.Teams.StewardSupervisor do
  use Supervisor

  @steward_agents [
    # steward 주기 서비스는 launchd가 canonical owner다.
  ]

  def start_link(opts \\ []) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    children =
      Enum.map(@steward_agents, fn agent ->
        {Jay.Core.Agents.PortAgent,
         name: agent.name, team: :steward, script: agent.script, schedule: agent.schedule}
      end)

    Supervisor.init(children, strategy: :one_for_one, max_restarts: 5, max_seconds: 60)
  end
end
