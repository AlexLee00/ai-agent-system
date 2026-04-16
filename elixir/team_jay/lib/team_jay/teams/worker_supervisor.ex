defmodule TeamJay.Teams.WorkerSupervisor do
  use Supervisor

  @worker_agents [
    %{name: :worker_health_check, script: "bots/worker/scripts/health-check.js", schedule: {:interval, 600_000}},
    %{name: :worker_task_runner, script: "bots/worker/src/task-runner.js", schedule: :once}
  ]

  def start_link(opts \\ []) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    children =
      Enum.map(@worker_agents, fn agent ->
        {TeamJay.Agents.PortAgent,
         name: agent.name, team: :worker, script: agent.script, schedule: agent.schedule}
      end)

    Supervisor.init(children, strategy: :one_for_one, max_restarts: 5, max_seconds: 60)
  end
end
