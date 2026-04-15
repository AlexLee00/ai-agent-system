defmodule TeamJay.Investment.Phase5MasterTrendSuite do
  @moduledoc """
  Phase 5의 master status와 persistence history를 묶어 상위 추세를 판정한다.
  """

  alias TeamJay.Investment.Phase5MasterStatusSuite
  alias TeamJay.Investment.Phase5PersistenceHistory

  def run_defaults(opts \\ []) do
    master = Phase5MasterStatusSuite.run_defaults(opts)
    persistence = Phase5PersistenceHistory.run_defaults(opts)

    positive_tables = Enum.count(persistence.rows, &(&1.delta_rows > 0))
    stagnant_tables = Enum.count(persistence.rows, &(&1.delta_rows == 0))
    negative_tables = Enum.count(persistence.rows, &(&1.delta_rows < 0))
    total_delta_rows = Enum.reduce(persistence.rows, 0, &(&1.delta_rows + &2))
    trend_status = derive_trend_status(master.ready, total_delta_rows)

    status =
      cond do
        not master.ready or not persistence.all_ok ->
          :phase5_master_trend_check

        trend_status == :phase5_trending_up and master.status == :phase5_master_advanced ->
          :phase5_master_trending_advanced

        trend_status == :phase5_trending_up ->
          :phase5_master_trending_up

        true ->
          :phase5_master_trend_stable
      end

    %{
      status: status,
      ready: master.ready and persistence.all_ok,
      master: master,
      trend_status: trend_status,
      persistence: persistence,
      blocker_count: length(master.blockers),
      total_delta_rows: total_delta_rows,
      positive_tables: positive_tables,
      stagnant_tables: stagnant_tables,
      negative_tables: negative_tables
    }
  end

  defp derive_trend_status(false, _total_delta_rows), do: :phase5_trend_check
  defp derive_trend_status(true, total_delta_rows) when total_delta_rows > 0, do: :phase5_trending_up
  defp derive_trend_status(true, _total_delta_rows), do: :phase5_stable
end
