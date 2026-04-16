defmodule TeamJay.Teams.WorkerSupervisor do
  use Supervisor

  @worker_agents [
    %{name: :worker_health_check, script: "bots/worker/scripts/health-check.js", schedule: {:interval, 600_000}},
    %{name: :worker_task_runner, script: "bots/worker/src/task-runner.js", schedule: :once},
    %{name: :worker_claude_monitor, script: "bots/worker/scripts/claude-api-monitor.js --alert-only", schedule: {:interval, 60_000}},
    %{name: :worker_lead, script: "bots/worker/src/worker-lead.js", schedule: :once},
    %{
      name: :worker_web,
      script: "/Users/alexlee/projects/ai-agent-system/bots/worker/scripts/start-worker-web.sh",
      runner: {:shell, "/bin/bash"},
      schedule: if(Mix.env() == :test, do: nil, else: :once),
      health_url: "http://127.0.0.1:4000/api/health"
    },
    %{
      name: :worker_nextjs,
      script:
        "export PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin && cd /Users/alexlee/projects/ai-agent-system/bots/worker/web && npm run start -- -H 0.0.0.0 -p 4001",
      runner: {:shell, "/bin/bash"},
      schedule: if(Mix.env() == :test, do: nil, else: :once),
      health_url: "http://127.0.0.1:4001"
    }
  ]

  def start_link(opts \\ []) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    children =
      Enum.map(@worker_agents, fn agent ->
        {TeamJay.Agents.PortAgent,
         name: agent.name,
         team: :worker,
         script: agent.script,
         runner: Map.get(agent, :runner, :node),
         schedule: agent.schedule,
         health_url: Map.get(agent, :health_url)}
      end)

    Supervisor.init(children, strategy: :one_for_one, max_restarts: 5, max_seconds: 60)
  end
end
