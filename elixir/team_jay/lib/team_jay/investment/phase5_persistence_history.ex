defmodule TeamJay.Investment.Phase5PersistenceHistory do
  @moduledoc """
  Phase 5 persistence snapshot을 DB에 누적 저장하고 직전 스냅샷과 비교한다.
  """

  alias Ecto.Adapters.SQL
  alias TeamJay.Investment.Phase5PersistenceSuite
  alias Jay.Core.Repo

  def run_defaults(opts \\ []) do
    ensure_table!()

    full = Keyword.get(opts, :full)
    suite_opts =
      if full do
        Keyword.put(opts, :full, full)
      else
        opts
      end

    result = Phase5PersistenceSuite.run_defaults(suite_opts)
    batch_id = System.unique_integer([:positive, :monotonic])
    recorded_at = DateTime.utc_now()

    previous_rows = previous_rows()

    rows =
      Enum.map(result.rows, fn row ->
        previous = Map.get(previous_rows, row.key)
        delta_rows = row.row_count - (previous && previous.row_count || 0)
        delta_symbols = row.symbol_count - (previous && previous.symbol_count || 0)

        persist_row(batch_id, recorded_at, row)

        Map.merge(row, %{
          previous_row_count: previous && previous.row_count || 0,
          previous_symbol_count: previous && previous.symbol_count || 0,
          delta_rows: delta_rows,
          delta_symbols: delta_symbols
        })
      end)

    %{
      batch_id: batch_id,
      recorded_at: recorded_at,
      total: length(rows),
      passed: Enum.count(rows, &(&1.status == :ok)),
      failed: Enum.count(rows, &(&1.status != :ok)),
      all_ok: result.all_ok,
      full: result.full,
      rows: rows
    }
  end

  defp ensure_table! do
    SQL.query!(Repo, "CREATE SCHEMA IF NOT EXISTS investment", [])

    SQL.query!(
      Repo,
      """
      CREATE TABLE IF NOT EXISTS investment.phase5_persistence_snapshots (
        id BIGSERIAL PRIMARY KEY,
        batch_id BIGINT NOT NULL,
        snapshot_key TEXT NOT NULL,
        label TEXT NOT NULL,
        table_name TEXT NOT NULL,
        row_count BIGINT NOT NULL DEFAULT 0,
        symbol_count BIGINT NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL,
        inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      CREATE INDEX IF NOT EXISTS phase5_persistence_snapshots_batch_idx
      ON investment.phase5_persistence_snapshots (batch_id DESC, snapshot_key)
      """,
      []
    )
  end

  defp previous_rows do
    case SQL.query(
           Repo,
           """
           WITH latest AS (
             SELECT max(batch_id) AS batch_id
             FROM investment.phase5_persistence_snapshots
           )
           SELECT snapshot_key, row_count, symbol_count
           FROM investment.phase5_persistence_snapshots
           WHERE batch_id = (SELECT batch_id FROM latest)
           """,
           []
         ) do
      {:ok, %{rows: rows}} ->
        Map.new(rows, fn [snapshot_key, row_count, symbol_count] ->
          {existing_key(snapshot_key), %{row_count: row_count, symbol_count: symbol_count}}
        end)

      _ ->
        %{}
    end
  end

  defp persist_row(batch_id, recorded_at, row) do
    SQL.query!(
      Repo,
      """
      INSERT INTO investment.phase5_persistence_snapshots (
        batch_id,
        snapshot_key,
        label,
        table_name,
        row_count,
        symbol_count,
        status,
        recorded_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      """,
      [
        batch_id,
        Atom.to_string(row.key),
        row.label,
        row.table,
        row.row_count,
        row.symbol_count,
        Atom.to_string(row.status),
        recorded_at
      ]
    )
  end

  defp existing_key(snapshot_key) do
    try do
      String.to_existing_atom(snapshot_key)
    rescue
      ArgumentError -> snapshot_key
    end
  end
end
