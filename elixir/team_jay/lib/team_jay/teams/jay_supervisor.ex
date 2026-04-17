defmodule TeamJay.Teams.JaySupervisor do
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
    Logger.info("[JaySupervisor] 시작 — 9팀 성장 오케스트레이터")

    children = [
      TeamJay.Jay.AutonomyController,
      TeamJay.Jay.GrowthCycle,
      TeamJay.Jay.CrossTeamRouter,
      TeamJay.Jay.N8nBridge,
    ]

    Supervisor.init(children, strategy: :one_for_one)
  end
end
