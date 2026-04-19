defmodule TeamJay.Teams.ClaudeSupervisor do
  use Supervisor

  @claude_agents [
    %{name: :dexter, script: "bots/claude/src/dexter.ts", runner: :tsx, schedule: {:interval, 300_000}},
    %{name: :dexter_daily, script: "bots/claude/src/dexter.ts --daily-report --telegram", runner: :tsx, schedule: nil},
    # launchd ai.claude.dexter.quick 가 canonical owner이므로 Elixir PortAgent에선 중복 실행하지 않는다.
    # launchd가 canonical owner인 상시/캘린더 서비스는 PortAgent 목록에서 제외한다.
    %{name: :speed_test, script: "bots/claude/scripts/speed-test.ts", runner: :tsx, schedule: {:interval, 86_400_000}},
  ]

  def start_link(opts \\ []) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    native_children = [
      # 덱스터
      TeamJay.Claude.Dexter.ErrorTracker,
      TeamJay.Claude.Dexter.TestRunner,
      # 닥터
      TeamJay.Claude.Doctor.Dispatch,
      # 모니터
      TeamJay.Claude.Monitor.DeploymentMonitor,
      # 코덱스 파이프라인
      TeamJay.Claude.Codex.CodexWatcher,
      TeamJay.Claude.Codex.CodexPipeline,
      # 크로스팀 피드백 루프
      TeamJay.Claude.FeedbackLoop,
      # 히스토리 라이터 (주간 RAG 축적)
      TeamJay.Claude.HistoryWriter
    ]

    port_children =
      Enum.map(@claude_agents, fn agent ->
        {Jay.Core.Agents.PortAgent,
         name: agent.name, team: :claude, script: agent.script,
         runner: Map.get(agent, :runner, :tsx), schedule: agent.schedule}
      end)

    Supervisor.init(native_children ++ port_children, strategy: :one_for_one, max_restarts: 8, max_seconds: 60)
  end
end
