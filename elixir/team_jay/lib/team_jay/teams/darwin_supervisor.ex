defmodule TeamJay.Teams.DarwinSupervisor do
  use Supervisor

  @moduledoc """
  다윈팀 Supervisor — 완전자율 연구 에이전트

  bots/darwin/으로 독립 분리 (이전: bots/orchestrator/lib/research/)
  7단계 무한 연구 루프: DISCOVER→EVALUATE→PLAN→IMPLEMENT→VERIFY→APPLY→LEARN

  자율 레벨:
  - L3: 현재 (에러 4회 강등 상태)
  - L4: 연속 5회 성공 + 7일 경과
  - L5: 완전 자율 (마스터 승인 불필요)

  에이전트 분류:
  - interval_agents: PortAgent가 자체 타이머로 반복 실행
  - calendar_agents: Quantum Scheduler가 트리거
  """

  @interval_agents [
    %{
      name: :darwin_monitor,
      script: "bots/darwin/lib/research-monitor.ts",
      runner: :tsx,
      schedule: {:interval, 600_000}
    },
    %{
      name: :darwin_keyword_evolver,
      script: "bots/darwin/lib/keyword-evolver.ts",
      runner: :tsx,
      schedule: {:interval, 86_400_000}
    }
  ]

  @calendar_agents [
    # 매일 06:00 KST — 논문 스캔
    %{name: :darwin_scanner, script: "bots/darwin/lib/research-scanner.ts", runner: :tsx},
    # 매일 07:00 KST — 리서치 태스크 실행
    %{name: :darwin_task_runner, script: "bots/darwin/scripts/research-task-runner.ts", runner: :tsx},
    # 수동/온디맨드 에이전트
    %{name: :darwin_evaluator,  script: "bots/darwin/lib/research-evaluator.ts", runner: :tsx},
    %{name: :darwin_edison,     script: "bots/darwin/lib/implementor.ts", runner: :tsx},
    %{name: :darwin_proof_r,    script: "bots/darwin/lib/verifier.ts", runner: :tsx},
    %{name: :darwin_applier,    script: "bots/darwin/lib/applicator.ts", runner: :tsx},
  ]

  def start_link(opts \\ []) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    native_children = [
      TeamJay.Darwin.TeamLead,
      TeamJay.Darwin.FeedbackLoop
    ]

    children = native_children ++ interval_children() ++ calendar_children()
    Supervisor.init(children, strategy: :one_for_one, max_restarts: 5, max_seconds: 60)
  end

  defp interval_children do
    Enum.map(@interval_agents, fn agent ->
      {TeamJay.Agents.PortAgent,
       name: agent.name,
       team: :darwin,
       script: agent.script,
       runner: Map.get(agent, :runner, :tsx),
       schedule: agent.schedule}
    end)
  end

  defp calendar_children do
    Enum.map(@calendar_agents, fn agent ->
      {TeamJay.Agents.PortAgent,
       name: agent.name,
       team: :darwin,
       script: agent.script,
       runner: Map.get(agent, :runner, :tsx),
       schedule: nil}
    end)
  end

  @doc "활성 에이전트 이름 목록"
  def agent_names do
    (@interval_agents ++ @calendar_agents)
    |> Enum.map(& &1.name)
  end

  @doc "ownership manifest와 대조할 Elixir-managed launch labels"
  def agent_labels do
    [
      "ai.research.scanner",
      "ai.research.task-runner"
    ]
  end
end
