defmodule TeamJay.Investment.Phase5TrendHistory do
  @moduledoc """
  Phase 5 trend 스냅샷을 DB에 누적 저장하고 직전 상태와 비교한다.
  """

  alias Ecto.Adapters.SQL
  alias TeamJay.Investment.Phase5TrendSuite
  alias Jay.Core.Repo

  def run_defaults(opts \\ []) do
    ensure_table!()

    result = Phase5TrendSuite.run_defaults(opts)
    recorded_at = DateTime.utc_now()
    previous = previous_snapshot()

    persist_snapshot(recorded_at, result)

    %{
      recorded_at: recorded_at,
      status: result.status,
      ready: result.ready,
      previous_status: previous && previous.status,
      previous_ready: previous && previous.ready || false,
      previous_total_delta_rows: previous && previous.total_delta_rows || 0,
      total_delta_rows: result.total_delta_rows,
      delta_from_previous: result.total_delta_rows - (previous && previous.total_delta_rows || 0),
      positive_tables: result.positive_tables,
      stagnant_tables: result.stagnant_tables,
      negative_tables: result.negative_tables,
      transitioned: previous && previous.status != result.status || false,
      suite: result
    }
  end

  defp ensure_table! do
    SQL.query!(Repo, "CREATE SCHEMA IF NOT EXISTS investment", [])

    SQL.query!(
      Repo,
      """
      CREATE TABLE IF NOT EXISTS investment.phase5_trend_snapshots (
        id BIGSERIAL PRIMARY KEY,
        status TEXT NOT NULL,
        ready BOOLEAN NOT NULL DEFAULT FALSE,
        total_delta_rows BIGINT NOT NULL DEFAULT 0,
        positive_tables INTEGER NOT NULL DEFAULT 0,
        stagnant_tables INTEGER NOT NULL DEFAULT 0,
        negative_tables INTEGER NOT NULL DEFAULT 0,
        master_status TEXT NOT NULL,
        master_ready BOOLEAN NOT NULL DEFAULT FALSE,
        recorded_at TIMESTAMPTZ NOT NULL,
        inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      CREATE INDEX IF NOT EXISTS phase5_trend_snapshots_recorded_at_idx
      ON investment.phase5_trend_snapshots (recorded_at DESC)
      """,
      []
    )
  end

  defp previous_snapshot do
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
        %{
          status: to_known_atom(status),
          ready: ready,
          total_delta_rows: total_delta_rows
        }

      _ ->
        nil
    end
  end

  defp persist_snapshot(recorded_at, result) do
    SQL.query!(
      Repo,
      """
      INSERT INTO investment.phase5_trend_snapshots (
        status,
        ready,
        total_delta_rows,
        positive_tables,
        stagnant_tables,
        negative_tables,
        master_status,
        master_ready,
        recorded_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      """,
      [
        Atom.to_string(result.status),
        result.ready,
        result.total_delta_rows,
        result.positive_tables,
        result.stagnant_tables,
        result.negative_tables,
        Atom.to_string(result.master.status),
        result.master.ready,
        recorded_at
      ]
    )
  end

  defp to_known_atom(value) when is_binary(value) do
    try do
      String.to_existing_atom(value)
    rescue
      ArgumentError -> String.to_atom(value)
    end
  end
end
