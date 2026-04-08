defmodule TeamJay.Teams.StewardSupervisor do
  use Supervisor

  @steward_agents [
    %{name: :steward_hourly, script: "bots/steward/scripts/hourly.js", schedule: {:interval, 3_600_000}},
    %{name: :steward_daily, script: "bots/steward/scripts/daily.js", schedule: {:interval, 86_400_000}},
    %{name: :steward_weekly, script: "bots/steward/scripts/weekly.js", schedule: nil}
  ]

  def start_link(opts \\ []) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    children =
      Enum.map(@steward_agents, fn agent ->
        {TeamJay.Agents.PortAgent,
         name: agent.name, team: :steward, script: agent.script, schedule: agent.schedule}
      end)

    Supervisor.init(children, strategy: :one_for_one, max_restarts: 5, max_seconds: 60)
  end
end
