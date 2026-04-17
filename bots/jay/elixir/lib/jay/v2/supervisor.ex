defmodule Jay.V2.Supervisor do
  @moduledoc """
  제이팀 성장 오케스트레이터 Supervisor.
  GrowthCycle + CrossTeamRouter 관리.
  """

  use Supervisor
  require Logger

  def start_link(_opts) do
    Supervisor.start_link(__MODULE__, [], name: __MODULE__)
  end

  @impl true
  def init([]) do
    Logger.info("[Jay.V2.Supervisor] 시작 — 9팀 성장 오케스트레이터")

    children =
      if System.get_env("JAY_V2_ENABLED") == "true" do
        [
          Jay.V2.AutonomyController,
          Jay.V2.GrowthCycle,
          Jay.V2.CrossTeamRouter,
          Jay.V2.N8nBridge
          # Jay.V2.Commander는 함수형 호출 (시그마 패턴) — Phase 4에서 AgentServer로 전환
        ]
      else
        []
      end

    Supervisor.init(children, strategy: :one_for_one)
  end
end
