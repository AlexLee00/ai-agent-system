defmodule TeamJay.Teams.ClaudeSupervisor do
  use Supervisor

  @claude_agents [
    %{name: :dexter, script: "bots/claude/src/dexter.js", schedule: {:interval, 300_000}},
    %{name: :dexter_daily, script: "bots/claude/src/dexter.js --daily-report --telegram", schedule: nil},
    %{name: :dexter_quick, script: "bots/claude/src/dexter-quickcheck.js --telegram --fix", schedule: {:interval, 60_000}},
    # launchd가 canonical owner인 상시/캘린더 서비스는 PortAgent 목록에서 제외한다.
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
