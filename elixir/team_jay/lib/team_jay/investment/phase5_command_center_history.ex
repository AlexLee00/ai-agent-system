defmodule TeamJay.Investment.Phase5CommandCenterHistory do
  @moduledoc """
  Phase 5 command center 스냅샷을 DB에 누적 저장하고 직전 상태와 비교한다.
  """

  alias Ecto.Adapters.SQL
  alias TeamJay.Investment.Phase5CommandCenterSuite
  alias TeamJay.Repo

  def run_defaults(opts \\ []) do
    ensure_table!()

    result = Phase5CommandCenterSuite.run_defaults(opts)
    recorded_at = DateTime.utc_now()
    previous = previous_snapshot()
    blockers = Enum.map(result.blockers, &Atom.to_string/1)

    persist_snapshot(recorded_at, result, blockers)

    %{
      recorded_at: recorded_at,
      status: result.status,
      ready: result.ready,
      blockers: blockers,
      previous_status: previous && previous.status,
      previous_ready: previous && previous.ready || false,
      previous_blockers: previous && previous.blockers || [],
      blocker_delta: length(blockers) - length(previous && previous.blockers || []),
      transitioned: previous && previous.status != result.status || false,
      suite: result
    }
  end

  defp ensure_table! do
    SQL.query!(Repo, "CREATE SCHEMA IF NOT EXISTS investment", [])

    SQL.query!(
      Repo,
      """
      CREATE TABLE IF NOT EXISTS investment.phase5_command_center_snapshots (
        id BIGSERIAL PRIMARY KEY,
        status TEXT NOT NULL,
        ready BOOLEAN NOT NULL DEFAULT FALSE,
        blocker_count INTEGER NOT NULL DEFAULT 0,
        blockers JSONB NOT NULL DEFAULT '[]'::jsonb,
        control_tower_status TEXT NOT NULL,
        control_tower_history_status TEXT NOT NULL,
        overview_status TEXT NOT NULL,
        master_trend_status TEXT NOT NULL,
        closeout_status TEXT NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL,
        inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      CREATE INDEX IF NOT EXISTS phase5_command_center_snapshots_recorded_at_idx
      ON investment.phase5_command_center_snapshots (recorded_at DESC)
      """,
      []
    )
  end

  defp previous_snapshot do
    case SQL.query(
           Repo,
           """
           SELECT status, ready, blockers
           FROM investment.phase5_command_center_snapshots
           ORDER BY recorded_at DESC
           LIMIT 1
           """,
           []
         ) do
      {:ok, %{rows: [[status, ready, blockers]]}} ->
        %{
          status: to_known_atom(status),
          ready: ready,
          blockers: normalize_blockers(blockers)
        }

      _ ->
        nil
    end
  end

  defp persist_snapshot(recorded_at, result, blockers) do
    SQL.query!(
      Repo,
      """
      INSERT INTO investment.phase5_command_center_snapshots (
        status,
        ready,
        blocker_count,
        blockers,
        control_tower_status,
        control_tower_history_status,
        overview_status,
        master_trend_status,
        closeout_status,
        recorded_at
      )
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10)
      """,
      [
        Atom.to_string(result.status),
        result.ready,
        length(blockers),
        Jason.encode!(blockers),
        Atom.to_string(result.control_tower.status),
        Atom.to_string(result.control_tower_history.status),
        Atom.to_string(result.overview.status),
        Atom.to_string(result.master_trend.status),
        Atom.to_string(result.closeout.status),
        recorded_at
      ]
    )
  end

  defp normalize_blockers(blockers) when is_list(blockers), do: blockers
  defp normalize_blockers(_), do: []

  defp to_known_atom(value) when is_binary(value) do
    try do
      String.to_existing_atom(value)
    rescue
      ArgumentError -> String.to_atom(value)
    end
  end
end
