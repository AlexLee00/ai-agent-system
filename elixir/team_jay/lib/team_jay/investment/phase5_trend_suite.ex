defmodule TeamJay.Investment.Phase5TrendSuite do
  @moduledoc """
  Phase 5 master status와 persistence history를 묶어 현재 추세를 요약한다.
  """

  alias TeamJay.Investment.Phase5MasterStatusHistory
  alias TeamJay.Investment.Phase5PersistenceHistory

  def run_defaults(opts \\ []) do
    master = Phase5MasterStatusHistory.run_defaults(opts)
    persistence = Phase5PersistenceHistory.run_defaults(opts)

    positive_tables = Enum.count(persistence.rows, &(&1.delta_rows > 0))
    stagnant_tables = Enum.count(persistence.rows, &(&1.delta_rows == 0))
    negative_tables = Enum.count(persistence.rows, &(&1.delta_rows < 0))
    total_delta_rows = Enum.reduce(persistence.rows, 0, &(&1.delta_rows + &2))

    status =
      cond do
        not master.ready -> :phase5_trend_check
        total_delta_rows > 0 -> :phase5_trending_up
        true -> :phase5_stable
      end

    %{
      status: status,
      master: master,
      persistence: persistence,
      positive_tables: positive_tables,
      stagnant_tables: stagnant_tables,
      negative_tables: negative_tables,
      total_delta_rows: total_delta_rows,
      ready: master.ready and persistence.all_ok
    }
  end
end
