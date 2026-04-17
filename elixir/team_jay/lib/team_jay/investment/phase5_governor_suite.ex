defmodule TeamJay.Investment.Phase5GovernorSuite do
  @moduledoc """
  Phase 5 상위 운영 추세를 묶는 governor suite.
  """

  alias Ecto.Adapters.SQL
  alias Jay.Core.Repo

  def run_defaults(_opts \\ []) do
    operations = latest_operations()
    operations_history = latest_operations_history()
    mission_control = latest_simple_snapshot("investment.phase5_mission_control_snapshots", :phase5_mission_control_check)
    closeout = latest_simple_snapshot("investment.phase5_closeout_snapshots", :phase5_ready_check)

    blockers =
      []
      |> maybe_add(not operations.ready, :operations_check)
      |> maybe_add(not operations_history.ready, :operations_history_check)
      |> maybe_add(not mission_control.ready, :mission_control_check)
      |> maybe_add(not closeout.ready, :closeout_check)

    status =
      cond do
        blockers != [] ->
          :phase5_governor_check

        operations.status == :phase5_operations_advanced ->
          :phase5_governor_advanced

        operations.status == :phase5_operations_ready ->
          :phase5_governor_ready

        true ->
          :phase5_governor_stable
      end

    %{
      status: status,
      ready: blockers == [],
      blockers: blockers,
      operations: operations,
      operations_history: operations_history,
      mission_control: mission_control,
      closeout: closeout
    }
  end

  defp latest_operations do
    case SQL.query(
           Repo,
           """
           SELECT status, ready, blocker_count, diagnostics_severity
           FROM investment.phase5_operations_snapshots
           ORDER BY recorded_at DESC
           LIMIT 1
           """,
           []
         ) do
      {:ok, %{rows: [[status, ready, blocker_count, diagnostics_severity]]}} ->
        %{
          status: to_known_atom(status),
          ready: ready,
          blocker_count: blocker_count,
          diagnostics_severity: to_known_atom(diagnostics_severity)
        }

      _ ->
        %{
          status: :phase5_operations_check,
          ready: false,
          blocker_count: 0,
          diagnostics_severity: :info
        }
    end
  end

  defp latest_operations_history do
    case SQL.query(
           Repo,
           """
           SELECT status, ready, blocker_count
           FROM investment.phase5_operations_snapshots
           ORDER BY recorded_at DESC
           OFFSET 1
           LIMIT 1
           """,
           []
         ) do
      {:ok, %{rows: [[status, ready, blocker_count]]}} ->
        %{status: to_known_atom(status), ready: ready, blocker_count: blocker_count}

      _ ->
        %{status: :phase5_operations_check, ready: false, blocker_count: 0}
    end
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
