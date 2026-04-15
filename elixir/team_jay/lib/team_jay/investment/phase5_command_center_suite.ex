defmodule TeamJay.Investment.Phase5CommandCenterSuite do
  @moduledoc """
  Phase 5 최종 운영 snapshot을 한 번에 묶는 command center suite.
  """

  alias Ecto.Adapters.SQL
  alias TeamJay.Repo

  def run_defaults(_opts \\ []) do
    control_tower = latest_control_tower()
    control_tower_history = latest_control_tower_history()
    overview = latest_overview()
    master_trend = latest_master_trend()
    closeout = latest_closeout()

    blockers =
      []
      |> maybe_add(not control_tower.ready, :control_tower_check)
      |> maybe_add(not control_tower_history.ready, :control_tower_history_check)
      |> maybe_add(not overview.ready, :overview_check)
      |> maybe_add(not master_trend.ready, :master_trend_check)
      |> maybe_add(not closeout.ready, :closeout_check)

    status =
      cond do
        blockers != [] ->
          :phase5_command_center_check

        control_tower.status == :phase5_control_tower_advanced ->
          :phase5_command_center_advanced

        control_tower.status == :phase5_control_tower_ready ->
          :phase5_command_center_ready

        true ->
          :phase5_command_center_stable
      end

    %{
      status: status,
      ready: blockers == [],
      blockers: blockers,
      control_tower: control_tower,
      control_tower_history: control_tower_history,
      overview: overview,
      master_trend: master_trend,
      closeout: closeout
    }
  end

  defp latest_control_tower do
    case SQL.query(
           Repo,
           """
           SELECT status, ready, blocker_count
           FROM investment.phase5_control_tower_snapshots
           ORDER BY recorded_at DESC
           LIMIT 1
           """,
           []
         ) do
      {:ok, %{rows: [[status, ready, blocker_count]]}} ->
        %{status: to_known_atom(status), ready: ready, blocker_count: blocker_count}

      _ ->
        %{status: :phase5_control_tower_check, ready: false, blocker_count: 0}
    end
  end

  defp latest_control_tower_history do
    case SQL.query(
           Repo,
           """
           SELECT status, ready, blocker_count
           FROM investment.phase5_control_tower_snapshots
           ORDER BY recorded_at DESC
           LIMIT 1
           """,
           []
         ) do
      {:ok, %{rows: [[status, ready, blocker_count]]}} ->
        %{status: to_known_atom(status), ready: ready, blocker_count: blocker_count}

      _ ->
        %{status: :phase5_control_tower_check, ready: false, blocker_count: 0}
    end
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
