defmodule TeamJay.Investment.Phase5ExecutiveSuite do
  @moduledoc """
  Phase 5 최종 executive snapshot을 한 번에 묶는 suite.
  """

  alias Ecto.Adapters.SQL
  alias TeamJay.Repo

  def run_defaults(_opts \\ []) do
    command_center = latest_command_center()
    command_center_history = latest_command_center_history()
    control_tower = latest_control_tower()
    overview = latest_overview()
    closeout = latest_closeout()

    blockers =
      []
      |> maybe_add(not command_center.ready, :command_center_check)
      |> maybe_add(not command_center_history.ready, :command_center_history_check)
      |> maybe_add(not control_tower.ready, :control_tower_check)
      |> maybe_add(not overview.ready, :overview_check)
      |> maybe_add(not closeout.ready, :closeout_check)

    status =
      cond do
        blockers != [] ->
          :phase5_executive_check

        command_center.status == :phase5_command_center_advanced ->
          :phase5_executive_advanced

        command_center.status == :phase5_command_center_ready ->
          :phase5_executive_ready

        true ->
          :phase5_executive_stable
      end

    %{
      status: status,
      ready: blockers == [],
      blockers: blockers,
      command_center: command_center,
      command_center_history: command_center_history,
      control_tower: control_tower,
      overview: overview,
      closeout: closeout
    }
  end

  defp latest_command_center do
    latest_simple_snapshot(
      "investment.phase5_command_center_snapshots",
      :phase5_command_center_check
    )
  end

  defp latest_command_center_history do
    latest_simple_snapshot(
      "investment.phase5_command_center_snapshots",
      :phase5_command_center_check
    )
  end

  defp latest_control_tower do
    latest_simple_snapshot(
      "investment.phase5_control_tower_snapshots",
      :phase5_control_tower_check
    )
  end

  defp latest_overview do
    latest_simple_snapshot(
      "investment.phase5_overview_snapshots",
      :phase5_overview_check
    )
  end

  defp latest_closeout do
    latest_simple_snapshot(
      "investment.phase5_closeout_snapshots",
      :phase5_ready_check
    )
  end

  defp latest_simple_snapshot(table, fallback_status) do
    case SQL.query(
           Repo,
           "SELECT status, ready, blocker_count FROM #{table} ORDER BY recorded_at DESC LIMIT 1",
           []
         ) do
      {:ok, %{rows: [[status, ready, blocker_count]]}} ->
        %{status: to_known_atom(status), ready: ready, blocker_count: blocker_count}

      _ ->
        %{status: fallback_status, ready: false, blocker_count: 0}
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
