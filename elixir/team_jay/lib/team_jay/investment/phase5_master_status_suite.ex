defmodule TeamJay.Investment.Phase5MasterStatusSuite do
  @moduledoc """
  Phase 5의 full scaffold, persistence, closeout, closeout history를 한 번에 묶는다.
  """

  alias TeamJay.Investment.Phase5CloseoutHistory
  alias TeamJay.Investment.Phase5CloseoutSuite
  alias TeamJay.Investment.Phase5FullSuite
  alias TeamJay.Investment.Phase5PersistenceSuite

  def run_defaults(opts \\ []) do
    full = Keyword.get_lazy(opts, :full, fn -> Phase5FullSuite.run_defaults(opts) end)

    persistence =
      Keyword.get_lazy(opts, :persistence, fn ->
        Phase5PersistenceSuite.run_defaults(Keyword.put(opts, :full, full))
      end)

    closeout =
      Keyword.get_lazy(opts, :closeout, fn ->
        Phase5CloseoutSuite.run_defaults(
          opts
          |> Keyword.put(:full, full)
          |> Keyword.put(:persistence, persistence)
        )
      end)

    history =
      Keyword.get_lazy(opts, :history, fn ->
        Phase5CloseoutHistory.run_defaults(
          opts
          |> Keyword.put(:full, full)
          |> Keyword.put(:persistence, persistence)
        )
      end)

    blockers =
      []
      |> maybe_add(not full.all_ok, :full_scaffold_check)
      |> maybe_add(not persistence.all_ok, :persistence_check)
      |> maybe_add(not closeout.ready, :closeout_not_ready)
      |> maybe_add(not history.ready, :history_not_ready)

    status =
      cond do
        blockers == [] and history.transitioned -> :phase5_master_advanced
        blockers == [] -> :phase5_master_ready
        true -> :phase5_master_check
      end

    %{
      status: status,
      ready: blockers == [],
      blockers: blockers,
      full: full,
      persistence: persistence,
      closeout: closeout,
      history: history
    }
  end

  defp maybe_add(list, true, item), do: [item | list]
  defp maybe_add(list, false, _item), do: list
end
