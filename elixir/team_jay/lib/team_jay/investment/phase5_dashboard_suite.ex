defmodule TeamJay.Investment.Phase5DashboardSuite do
  @moduledoc """
  Phase 5 상위 snapshot을 한 번에 묶는 dashboard suite.
  """

  alias Ecto.Adapters.SQL
  alias Jay.Core.Repo

  def run_defaults(_opts \\ []) do
    closeout = latest_closeout()
    master = latest_master()
    trend = latest_trend()
    master_trend = latest_master_trend()
    persistence = latest_persistence()

    blockers =
      []
      |> maybe_add(not closeout.full_ok, :full_check)
      |> maybe_add(not closeout.persistence_ok or not persistence.all_ok, :persistence_check)
      |> maybe_add(not closeout.ready, :closeout_check)
      |> maybe_add(not master.ready, :master_check)
      |> maybe_add(not trend.ready, :trend_check)
      |> maybe_add(not master_trend.ready, :master_trend_check)

    status =
      cond do
        blockers != [] ->
          :phase5_dashboard_check

        master_trend.status == :phase5_master_trending_advanced ->
          :phase5_dashboard_advanced

        master_trend.status == :phase5_master_trending_up ->
          :phase5_dashboard_ready

        true ->
          :phase5_dashboard_stable
      end

    %{
      status: status,
      ready: blockers == [],
      blockers: blockers,
      full: %{all_ok: closeout.full_ok},
      persistence: persistence,
      closeout: closeout,
      master: master,
      trend: trend,
      master_trend: master_trend
    }
  end

  defp latest_closeout do
    case SQL.query(
           Repo,
           """
           SELECT status, ready, full_ok, persistence_ok
           FROM investment.phase5_closeout_snapshots
           ORDER BY recorded_at DESC
           LIMIT 1
           """,
           []
         ) do
      {:ok, %{rows: [[status, ready, full_ok, persistence_ok]]}} ->
        %{
          status: to_known_atom(status),
          ready: ready,
          full_ok: full_ok,
          persistence_ok: persistence_ok
        }

      _ ->
        %{status: :phase5_ready_check, ready: false, full_ok: false, persistence_ok: false}
    end
  end

  defp latest_master do
    case SQL.query(
           Repo,
           """
           SELECT status, ready, blocker_count
           FROM investment.phase5_master_status_snapshots
           ORDER BY recorded_at DESC
           LIMIT 1
           """,
           []
         ) do
      {:ok, %{rows: [[status, ready, blocker_count]]}} ->
        %{status: to_known_atom(status), ready: ready, blocker_count: blocker_count}

      _ ->
        %{status: :phase5_master_check, ready: false, blocker_count: 0}
    end
  end

  defp latest_trend do
    case SQL.query(
           Repo,
           """
           SELECT status, ready, total_delta_rows
           FROM investment.phase5_trend_snapshots
           ORDER BY recorded_at DESC
           LIMIT 1
           """,
           []
         ) do
      {:ok, %{rows: [[status, ready, total_delta_rows]]}} ->
        %{status: to_known_atom(status), ready: ready, total_delta_rows: total_delta_rows}

      _ ->
        %{status: :phase5_trend_check, ready: false, total_delta_rows: 0}
    end
  end

  defp latest_master_trend do
    case SQL.query(
           Repo,
           """
           SELECT status, ready, total_delta_rows, blocker_count
           FROM investment.phase5_master_trend_snapshots
           ORDER BY recorded_at DESC
           LIMIT 1
           """,
           []
         ) do
      {:ok, %{rows: [[status, ready, total_delta_rows, blocker_count]]}} ->
        %{
          status: to_known_atom(status),
          ready: ready,
          total_delta_rows: total_delta_rows,
          blocker_count: blocker_count
        }

      _ ->
        %{status: :phase5_master_trend_check, ready: false, total_delta_rows: 0, blocker_count: 0}
    end
  end

  defp latest_persistence do
    case SQL.query(
           Repo,
           """
           WITH latest AS (
             SELECT max(batch_id) AS batch_id
             FROM investment.phase5_persistence_snapshots
           )
           SELECT count(*) FILTER (WHERE status = 'ok') AS passed,
                  count(*) AS total
           FROM investment.phase5_persistence_snapshots
           WHERE batch_id = (SELECT batch_id FROM latest)
           """,
           []
         ) do
      {:ok, %{rows: [[passed, total]]}} ->
        passed = passed || 0
        total = total || 0
        %{passed: passed, total: total, all_ok: total > 0 and passed == total}

      _ ->
        %{passed: 0, total: 0, all_ok: false}
    end
  end

  defp maybe_add(list, true, item), do: [item | list]
  defp maybe_add(list, false, _item), do: list

  defp to_known_atom(value) when is_binary(value) do
    try do
      String.to_existing_atom(value)
    rescue
      ArgumentError -> String.to_atom(value)
    end
  end
end
