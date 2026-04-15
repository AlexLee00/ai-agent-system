defmodule TeamJay.Investment.Phase5CloseoutHistory do
  @moduledoc """
  Phase 5 closeout readiness 스냅샷을 DB에 누적 저장하고 직전 상태와 비교한다.
  """

  alias Ecto.Adapters.SQL
  alias TeamJay.Investment.Phase5CloseoutSuite
  alias TeamJay.Repo

  def run_defaults(opts \\ []) do
    ensure_table!()

    result = Phase5CloseoutSuite.run_defaults(opts)
    recorded_at = DateTime.utc_now()
    previous = previous_snapshot()
    blockers = normalize_blockers(result.blockers)
    previous_blockers = previous && previous.blockers || []

    persist_snapshot(recorded_at, result, blockers)

    %{
      recorded_at: recorded_at,
      status: result.status,
      ready: result.ready,
      blockers: blockers,
      previous_status: previous && previous.status,
      previous_ready: previous && previous.ready || false,
      previous_blockers: previous_blockers,
      blocker_delta: length(blockers) - length(previous_blockers),
      transitioned: previous && previous.status != result.status || false,
      full: result.full,
      persistence: result.persistence
    }
  end

  defp ensure_table! do
    SQL.query!(Repo, "CREATE SCHEMA IF NOT EXISTS investment", [])

    SQL.query!(
      Repo,
      """
      CREATE TABLE IF NOT EXISTS investment.phase5_closeout_snapshots (
        id BIGSERIAL PRIMARY KEY,
        status TEXT NOT NULL,
        ready BOOLEAN NOT NULL DEFAULT FALSE,
        blocker_count INTEGER NOT NULL DEFAULT 0,
        blockers JSONB NOT NULL DEFAULT '[]'::jsonb,
        full_ok BOOLEAN NOT NULL DEFAULT FALSE,
        persistence_ok BOOLEAN NOT NULL DEFAULT FALSE,
        recorded_at TIMESTAMPTZ NOT NULL,
        inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      CREATE INDEX IF NOT EXISTS phase5_closeout_snapshots_recorded_at_idx
      ON investment.phase5_closeout_snapshots (recorded_at DESC)
      """,
      []
    )
  end

  defp previous_snapshot do
    case SQL.query(
           Repo,
           """
           SELECT status, ready, blockers
           FROM investment.phase5_closeout_snapshots
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
      INSERT INTO investment.phase5_closeout_snapshots (
        status,
        ready,
        blocker_count,
        blockers,
        full_ok,
        persistence_ok,
        recorded_at
      )
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
      """,
      [
        Atom.to_string(result.status),
        result.ready,
        length(blockers),
        Jason.encode!(Enum.map(blockers, &Atom.to_string/1)),
        result.full.all_ok,
        result.persistence.all_ok,
        recorded_at
      ]
    )
  end

  defp normalize_blockers(blockers) when is_list(blockers) do
    Enum.map(blockers, fn blocker ->
      cond do
        is_atom(blocker) -> blocker
        is_binary(blocker) -> to_known_atom(blocker)
        true -> blocker
      end
    end)
  end

  defp normalize_blockers(_), do: []

  defp to_known_atom(value) when is_binary(value) do
    try do
      String.to_existing_atom(value)
    rescue
      ArgumentError -> String.to_atom(value)
    end
  end
end
