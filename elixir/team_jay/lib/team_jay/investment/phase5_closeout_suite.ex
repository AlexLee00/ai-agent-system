defmodule TeamJay.Investment.Phase5CloseoutSuite do
  @moduledoc """
  Phase 5 closeout readiness를 판단하는 상위 suite.
  """

  alias TeamJay.Investment.Phase5FullSuite
  alias TeamJay.Investment.Phase5GovernorSuite
  alias TeamJay.Investment.Phase5OperationsSuite
  alias TeamJay.Investment.Phase5PersistenceSuite

  def run_defaults(opts \\ []) do
    full = Phase5FullSuite.run_defaults(opts)
    persistence = Phase5PersistenceSuite.run_defaults(opts)
    operations = Phase5OperationsSuite.run_defaults(opts)
    governor = Phase5GovernorSuite.run_defaults(opts)

    blockers =
      []
      |> maybe_add_blocker(not full.all_ok, :full_scaffold_not_ready)
      |> maybe_add_blocker(not persistence.all_ok, :persistence_not_ready)
      |> maybe_add_blocker(not persistence_rows_ready?(persistence.rows), :empty_persistence_rows)
      |> maybe_add_blocker(not operations.ready, :operations_not_ready)
      |> maybe_add_blocker(not governor.ready, :governor_not_ready)

    status =
      if blockers == [] do
        :phase5_ready_to_close
      else
        :phase5_in_progress
      end

    %{
      status: status,
      ready: blockers == [],
      blockers: blockers,
      full: full,
      persistence: persistence,
      operations: operations,
      governor: governor
    }
  end

  defp persistence_rows_ready?(rows) do
    Enum.all?(rows, fn row -> row.row_count > 0 and row.symbol_count > 0 end)
  end

  defp maybe_add_blocker(list, true, blocker), do: [blocker | list]
  defp maybe_add_blocker(list, false, _blocker), do: list
end
