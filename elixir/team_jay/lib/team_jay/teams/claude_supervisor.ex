defmodule TeamJay.Teams.ClaudeSupervisor do
  use Supervisor

  @claude_agents [
    %{name: :dexter, script: "bots/claude/src/dexter.js", schedule: {:interval, 300_000}},
    %{name: :dexter_daily, script: "bots/claude/scripts/dexter-daily.js", schedule: nil},
    %{name: :dexter_quick, script: "bots/claude/scripts/dexter-quick.js", schedule: {:interval, 60_000}},
    %{name: :claude_commander, script: "bots/claude/scripts/commander.js", schedule: {:interval, 600_000}},
    %{name: :archer, script: "bots/claude/scripts/archer.js", schedule: {:interval, 900_000}},
    %{name: :claude_health_check, script: "bots/claude/scripts/health-check.js", schedule: {:interval, 600_000}},
    %{name: :health_dashboard, script: "bots/claude/scripts/health-dashboard.js", schedule: {:interval, 600_000}},
    %{name: :speed_test, script: "bots/claude/scripts/speed-test.js", schedule: {:interval, 86_400_000}}
  ]

  def start_link(opts \\ []) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    children =
      Enum.map(@claude_agents, fn agent ->
        {TeamJay.Agents.PortAgent,
         name: agent.name, team: :claude, script: agent.script, schedule: agent.schedule}
      end)

    Supervisor.init(children, strategy: :one_for_one, max_restarts: 8, max_seconds: 60)
  end
end
