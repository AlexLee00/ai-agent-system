defmodule Sigma.V2.Supervisor do
  @moduledoc """
  Sigma V2 OTP Supervisor — v2 에이전트 트리 관리.

  상위 문서: docs/SIGMA_REMODELING_PLAN_2026-04-17.md §6
  Phase 0: skeleton only. SIGMA_V2_ENABLED=false 시 시작 건너뜀.

  자식 프로세스 (Phase 1에서 활성화):
    - Sigma.V2.Memory.L1    — ETS 세션 메모리
    - Sigma.V2.Commander    — Jido.AI.Agent 허브
  """

  use Supervisor

  def start_link(opts) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def init(_opts) do
    if System.get_env("SIGMA_V2_ENABLED") == "true" do
      children = [
        # TODO(Phase 1): Sigma.V2.Memory.L1
        # TODO(Phase 1): Sigma.V2.Commander
      ]
      Supervisor.init(children, strategy: :one_for_one)
    else
      Supervisor.init([], strategy: :one_for_one)
    end
  end
end
