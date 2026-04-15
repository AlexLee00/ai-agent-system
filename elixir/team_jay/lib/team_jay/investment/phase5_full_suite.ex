defmodule TeamJay.Investment.Phase5FullSuite do
  @moduledoc """
  Phase 5 전체 scaffold를 한 번에 검증하는 상위 suite.

  5-A / 5-B / 5-C / 5.5-4 / 5-D / 5-E 결과를 묶어서
  현재 Phase 5 전체 연결성이 기본 시장 세트에서 유지되는지 확인한다.
  """

  alias TeamJay.Investment.Phase5Suite
  alias TeamJay.Investment.Phase5LoopReport
  alias TeamJay.Investment.Phase5StrategyReport
  alias TeamJay.Investment.Phase5OverrideReport
  alias TeamJay.Investment.Phase5OverridePersistenceReport
  alias TeamJay.Investment.Phase5CircuitReport
  alias TeamJay.Investment.Phase5CircuitPersistenceReport
  alias TeamJay.Investment.Phase5MemoryReport
  alias TeamJay.Investment.Phase5MemoryPersistenceReport
  alias TeamJay.Investment.Phase5ModeReport
  alias TeamJay.Investment.Phase5ModePersistenceReport
  alias TeamJay.Investment.Phase5ResourceReport
  alias TeamJay.Investment.Phase5AutonomyReport
  alias TeamJay.Investment.Phase5ResourceHealthReport

  def run_defaults(opts \\ []) do
    base = Phase5Suite.run_defaults(opts)
    loop = Phase5LoopReport.run_defaults(opts)
    strategy = Phase5StrategyReport.run_defaults(opts)
    overrides = Phase5OverrideReport.run_defaults(opts)
    override_persistence = Phase5OverridePersistenceReport.run_defaults(opts)
    circuit = Phase5CircuitReport.run_defaults(opts)
    circuit_persistence = Phase5CircuitPersistenceReport.run_defaults(opts)
    memory = Phase5MemoryReport.run_defaults(opts)
    memory_persistence = Phase5MemoryPersistenceReport.run_defaults(opts)
    modes = Phase5ModeReport.run_defaults(opts)
    mode_persistence = Phase5ModePersistenceReport.run_defaults(opts)
    resources = Phase5ResourceReport.run_defaults(opts)
    autonomy = Phase5AutonomyReport.run_defaults(opts)
    resource_health = Phase5ResourceHealthReport.run_defaults(opts)

    all_ok =
      Enum.all?(
        [
          base.all_ok,
          loop.all_ok,
          strategy.result.all_ok,
          overrides.result.all_ok,
          override_persistence.result.all_ok,
          circuit.result.all_ok,
          circuit_persistence.result.all_ok,
          memory.result.all_ok,
          memory_persistence.result.all_ok,
          modes.result.all_ok,
          mode_persistence.result.all_ok,
          resources.result.all_ok,
          autonomy.result.all_ok,
          resource_health.result.all_ok
        ],
        & &1
      )

    %{
      all_ok: all_ok,
      phases: %{
        phase5_a: base,
        phase5_b: loop,
        phase5_c: strategy.result,
        phase5_5_4: overrides.result,
        phase5_5_4_db: override_persistence.result,
        phase5_5_5: circuit.result,
        phase5_5_5_db: circuit_persistence.result,
        phase5_d: memory.result,
        phase5_d_db: memory_persistence.result,
        phase5_e: modes.result,
        phase5_e_db: mode_persistence.result,
        phase5_5_8: resources.result,
        phase5_5_9: autonomy.result,
        phase5_resource_health: resource_health.result
      }
    }
  end
end
