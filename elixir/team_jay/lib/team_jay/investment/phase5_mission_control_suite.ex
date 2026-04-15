defmodule TeamJay.Investment.Phase5MissionControlSuite do
  @moduledoc """
  Phase 5 최상위 운영 snapshot을 한 번에 묶는 mission control suite.
  """

  alias Ecto.Adapters.SQL
  alias TeamJay.Repo

  def run_defaults(_opts \\ []) do
    executive = latest_executive()
    command_center = latest_command_center()
    resource_health = latest_resource_health()
    master_trend = latest_master_trend()
    closeout = latest_closeout()

    blockers =
      []
      |> maybe_add(not executive.ready, :executive_check)
      |> maybe_add(not command_center.ready, :command_center_check)
      |> maybe_add(not resource_health.ready, :resource_health_check)
      |> maybe_add(not master_trend.ready, :master_trend_check)
      |> maybe_add(not closeout.ready, :closeout_check)

    status =
      cond do
        blockers != [] ->
          :phase5_mission_control_check

        executive.status == :phase5_executive_advanced ->
          :phase5_mission_control_advanced

        executive.status == :phase5_executive_ready ->
          :phase5_mission_control_ready

        true ->
          :phase5_mission_control_stable
      end

    %{
      status: status,
      ready: blockers == [],
      blockers: blockers,
      executive: executive,
      command_center: command_center,
      resource_health: resource_health,
      master_trend: master_trend,
      closeout: closeout
    }
  end

  defp latest_executive do
    latest_simple_snapshot(
      "investment.phase5_executive_snapshots",
      :phase5_executive_check
    )
  end

  defp latest_command_center do
    latest_simple_snapshot(
      "investment.phase5_command_center_snapshots",
      :phase5_command_center_check
    )
  end

  defp latest_master_trend do
    latest_simple_snapshot(
      "investment.phase5_master_trend_snapshots",
      :phase5_master_trend_check
    )
  end

  defp latest_closeout do
    latest_simple_snapshot(
      "investment.phase5_closeout_snapshots",
      :phase5_ready_check
    )
  end

  defp latest_resource_health do
    case SQL.query(
           Repo,
           """
           SELECT status, ready, health_score
           FROM investment.resource_health_events
           ORDER BY measured_at DESC
           LIMIT 1
           """,
           []
         ) do
      {:ok, %{rows: [[status, ready, health_score]]}} ->
        known_status = to_known_atom(status)
        health_score = health_score || 0.0

        %{
          status: known_status,
          ready: ready or resource_health_observable?(known_status, health_score),
          health_score: health_score
        }

      _ ->
        %{status: :resource_health_check, ready: false, health_score: 0.0}
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

  defp resource_health_observable?(:observe, health_score) when health_score >= 0.8, do: true
  defp resource_health_observable?(_, _), do: false

  defp to_known_atom(value) when is_binary(value) do
    try do
      String.to_existing_atom(value)
    rescue
      ArgumentError -> String.to_atom(value)
    end
  end
end
