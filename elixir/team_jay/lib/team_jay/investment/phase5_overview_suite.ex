defmodule TeamJay.Investment.Phase5OverviewSuite do
  @moduledoc """
  Phase 5 최상위 snapshot을 한 번에 묶는 overview suite.
  """

  alias Ecto.Adapters.SQL
  alias Jay.Core.Repo

  def run_defaults(_opts \\ []) do
    dashboard = latest_dashboard()
    dashboard_history = latest_dashboard_history()
    master_trend = latest_master_trend()
    closeout = latest_closeout()

    blockers =
      []
      |> maybe_add(not dashboard.ready, :dashboard_check)
      |> maybe_add(not dashboard_history.ready, :dashboard_history_check)
      |> maybe_add(not master_trend.ready, :master_trend_check)
      |> maybe_add(not closeout.ready, :closeout_check)

    status =
      cond do
        blockers != [] ->
          :phase5_overview_check

        dashboard.status == :phase5_dashboard_advanced or
            master_trend.status == :phase5_master_trending_advanced ->
          :phase5_overview_advanced

        dashboard.status == :phase5_dashboard_ready ->
          :phase5_overview_ready

        true ->
          :phase5_overview_stable
      end

    %{
      status: status,
      ready: blockers == [],
      blockers: blockers,
      dashboard: dashboard,
      dashboard_history: dashboard_history,
      master_trend: master_trend,
      closeout: closeout
    }
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

  defp latest_dashboard_history do
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
