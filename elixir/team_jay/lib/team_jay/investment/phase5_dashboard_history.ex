defmodule TeamJay.Investment.Phase5DashboardHistory do
  @moduledoc """
  Phase 5 dashboard 스냅샷을 DB에 누적 저장하고 직전 상태와 비교한다.
  """

  alias Ecto.Adapters.SQL
  alias TeamJay.Investment.Phase5DashboardSuite
  alias TeamJay.Repo

  def run_defaults(opts \\ []) do
    ensure_table!()

    result = Phase5DashboardSuite.run_defaults(opts)
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
      CREATE TABLE IF NOT EXISTS investment.phase5_dashboard_snapshots (
        id BIGSERIAL PRIMARY KEY,
        status TEXT NOT NULL,
        ready BOOLEAN NOT NULL DEFAULT FALSE,
        blocker_count INTEGER NOT NULL DEFAULT 0,
        blockers JSONB NOT NULL DEFAULT '[]'::jsonb,
        full_ok BOOLEAN NOT NULL DEFAULT FALSE,
        persistence_ok BOOLEAN NOT NULL DEFAULT FALSE,
        closeout_ready BOOLEAN NOT NULL DEFAULT FALSE,
        master_status TEXT NOT NULL,
        trend_status TEXT NOT NULL,
        master_trend_status TEXT NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL,
        inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      CREATE INDEX IF NOT EXISTS phase5_dashboard_snapshots_recorded_at_idx
      ON investment.phase5_dashboard_snapshots (recorded_at DESC)
      """,
      []
    )
  end

  defp previous_snapshot do
    case SQL.query(
           Repo,
           """
           SELECT status, ready, blockers
           FROM investment.phase5_dashboard_snapshots
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
      INSERT INTO investment.phase5_dashboard_snapshots (
        status,
        ready,
        blocker_count,
        blockers,
        full_ok,
        persistence_ok,
        closeout_ready,
        master_status,
        trend_status,
        master_trend_status,
        recorded_at
      )
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11)
      """,
      [
        Atom.to_string(result.status),
        result.ready,
        length(blockers),
        Jason.encode!(blockers),
        result.full.all_ok,
        result.persistence.all_ok,
        result.closeout.ready,
        Atom.to_string(result.master.status),
        Atom.to_string(result.trend.status),
        Atom.to_string(result.master_trend.status),
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
