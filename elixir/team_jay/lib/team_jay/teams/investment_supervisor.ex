defmodule TeamJay.Teams.InvestmentSupervisor do
  use Supervisor

  @moduledoc """
  루나팀 PortAgent 전환용 스캐폴드.

  주의:
  - 아직 application.ex에는 연결하지 않는다.
  - calendar 기반 작업은 현재 PortAgent가 wall-clock 스케줄을 직접 지원하지 않아
    `schedule: nil`로 남기고 추후 TeamJay.Scheduler 또는 별도 래퍼에서 연결한다.
  """

  @investment_agents []

  def start_link(opts \\ []) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    children =
      Enum.map(@investment_agents, fn agent ->
        {TeamJay.Agents.PortAgent,
         name: agent.name, team: :investment, script: agent.script, schedule: agent.schedule}
      end)

    Supervisor.init(children, strategy: :one_for_one, max_restarts: 10, max_seconds: 60)
  end
end
