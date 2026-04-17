defmodule TeamJay.Investment.Phase5OperationsSuite do
  @moduledoc """
  Phase 5 최상위 운영 판단을 묶는 operations suite.
  """

  alias Ecto.Adapters.SQL
  alias Jay.Core.Repo

  def run_defaults(_opts \\ []) do
    mission_control = latest_simple_snapshot("investment.phase5_mission_control_snapshots", :phase5_mission_control_check)
    executive = latest_simple_snapshot("investment.phase5_executive_snapshots", :phase5_executive_check)
    closeout = latest_simple_snapshot("investment.phase5_closeout_snapshots", :phase5_ready_check)
    diagnostics = latest_diagnostics()

    blockers =
      []
      |> maybe_add(not mission_control.ready, :mission_control_check)
      |> maybe_add(not executive.ready, :executive_check)
      |> maybe_add(not closeout.ready, :closeout_check)
      |> maybe_add(diagnostics.blocking, :diagnostics_check)

    status =
      cond do
        blockers != [] ->
          :phase5_operations_check

        mission_control.status == :phase5_mission_control_advanced ->
          :phase5_operations_advanced

        mission_control.status == :phase5_mission_control_ready ->
          :phase5_operations_ready

        true ->
          :phase5_operations_stable
      end

    %{
      status: status,
      ready: blockers == [],
      blockers: blockers,
      mission_control: mission_control,
      executive: executive,
      closeout: closeout,
      diagnostics: diagnostics
    }
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

  defp latest_diagnostics do
    case SQL.query(
           Repo,
           """
           SELECT severity, created_at
           FROM agent.event_lake
           WHERE event_type = 'phase3_shadow_report'
           ORDER BY created_at DESC
           LIMIT 1
           """,
           []
         ) do
      {:ok, %{rows: [[severity, created_at]]}} ->
        known = to_known_atom(severity)

        %{
          severity: known,
          created_at: created_at,
          blocking: known in [:warn, :error]
        }

      _ ->
        %{severity: :info, created_at: nil, blocking: false}
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
