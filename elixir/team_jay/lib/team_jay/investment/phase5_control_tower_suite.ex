defmodule TeamJay.Investment.Phase5ControlTowerSuite do
  @moduledoc """
  Phase 5 최상위 운영 snapshot을 한 번에 묶는 control tower suite.
  """

  alias Ecto.Adapters.SQL
  alias Jay.Core.Repo

  def run_defaults(_opts \\ []) do
    overview = latest_overview()
    overview_history = latest_overview_history()
    dashboard = latest_dashboard()
    master_trend = latest_master_trend()
    closeout = latest_closeout()

    blockers =
      []
      |> maybe_add(not overview.ready, :overview_check)
      |> maybe_add(not overview_history.ready, :overview_history_check)
      |> maybe_add(not dashboard.ready, :dashboard_check)
      |> maybe_add(not master_trend.ready, :master_trend_check)
      |> maybe_add(not closeout.ready, :closeout_check)

    status =
      cond do
        blockers != [] ->
          :phase5_control_tower_check

        overview.status == :phase5_overview_advanced ->
          :phase5_control_tower_advanced

        overview.status == :phase5_overview_ready ->
          :phase5_control_tower_ready

        true ->
          :phase5_control_tower_stable
      end

    %{
      status: status,
      ready: blockers == [],
      blockers: blockers,
      overview: overview,
      overview_history: overview_history,
      dashboard: dashboard,
      master_trend: master_trend,
      closeout: closeout
    }
  end

  defp latest_overview do
    case SQL.query(
           Repo,
           """
           SELECT status, ready, blocker_count
           FROM investment.phase5_overview_snapshots
           ORDER BY recorded_at DESC
           LIMIT 1
           """,
           []
         ) do
      {:ok, %{rows: [[status, ready, blocker_count]]}} ->
        %{status: to_known_atom(status), ready: ready, blocker_count: blocker_count}

      _ ->
        %{status: :phase5_overview_check, ready: false, blocker_count: 0}
    end
  end

  defp latest_overview_history do
    case SQL.query(
           Repo,
           """
           SELECT status, ready, blocker_count
           FROM investment.phase5_overview_snapshots
           ORDER BY recorded_at DESC
           LIMIT 1
           """,
           []
         ) do
      {:ok, %{rows: [[status, ready, blocker_count]]}} ->
        %{status: to_known_atom(status), ready: ready, blocker_count: blocker_count}

      _ ->
        %{status: :phase5_overview_check, ready: false, blocker_count: 0}
    end
  end

  defp latest_dashboard do
    case SQL.query(
           Repo,
           """
           SELECT status, ready, blocker_count
           FROM investment.phase5_dashboard_snapshots
           ORDER BY recorded_at DESC
           LIMIT 1
           """,
           []
         ) do
      {:ok, %{rows: [[status, ready, blocker_count]]}} ->
        %{status: to_known_atom(status), ready: ready, blocker_count: blocker_count}

      _ ->
        %{status: :phase5_dashboard_check, ready: false, blocker_count: 0}
    end
  end

  defp latest_master_trend do
    case SQL.query(
           Repo,
           """
           SELECT status, ready, blocker_count
           FROM investment.phase5_master_trend_snapshots
           ORDER BY recorded_at DESC
           LIMIT 1
           """,
           []
         ) do
      {:ok, %{rows: [[status, ready, blocker_count]]}} ->
        %{status: to_known_atom(status), ready: ready, blocker_count: blocker_count}

      _ ->
        %{status: :phase5_master_trend_check, ready: false, blocker_count: 0}
    end
  end

  defp latest_closeout do
    case SQL.query(
           Repo,
           """
           SELECT status, ready, blocker_count
           FROM investment.phase5_closeout_snapshots
           ORDER BY recorded_at DESC
           LIMIT 1
           """,
           []
         ) do
      {:ok, %{rows: [[status, ready, blocker_count]]}} ->
        %{status: to_known_atom(status), ready: ready, blocker_count: blocker_count}

      _ ->
        %{status: :phase5_ready_check, ready: false, blocker_count: 0}
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
