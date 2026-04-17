defmodule Sigma.V2.Supervisor do
  @moduledoc """
  Sigma V2 OTP Supervisor — v2 에이전트 트리 관리.
  SIGMA_V2_ENABLED=true 시에만 자식 프로세스 기동.
  Phase 1: Memory.L1 활성화. Commander는 Phase 2에서 AgentServer로 기동.
  """

  use Supervisor

  def start_link(opts) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def init(_opts) do
    if System.get_env("SIGMA_V2_ENABLED") == "true" do
      children = [
        Sigma.V2.Memory.L1
      ]

      Supervisor.init(children, strategy: :one_for_one)
    else
      Supervisor.init([], strategy: :one_for_one)
    end
  end
end
