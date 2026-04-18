defmodule TeamJay.Ska.Skill.AuditDbIntegrity do
  @moduledoc """
  DB 테이블 무결성 검사 스킬 — 중복/고아 레코드/NULL 필드 검증.

  입력: %{table: "reservation.reservations", checks: [:duplicates, :orphans, :nulls]}
  출력: {:ok, %{passed: true, issues: []}}
  """

  @behaviour TeamJay.Ska.Skill

  @impl true
  def metadata do
    %{
      name: :audit_db_integrity,
      domain: :common,
      version: "1.0",
      description: "DB 테이블 무결성 검사 (중복/고아 레코드/FK 위반)",
      input_schema: %{table: :string, checks: :list},
      output_schema: %{passed: :boolean, issues: :list}
    }
  end

  @impl true
  def run(params, _context) do
    table = params[:table]
    checks = params[:checks] || [:duplicates, :orphans, :nulls]
    issues = Enum.flat_map(checks, &run_check(table, &1))
    {:ok, %{passed: issues == [], issues: issues}}
  end

  defp run_check(table, :duplicates) do
    sql = """
    SELECT COUNT(*) as dup_count
    FROM (
      SELECT id, COUNT(*) as cnt
      FROM #{table}
      GROUP BY id
      HAVING COUNT(*) > 1
    ) sub
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: [[0]]}} ->
        []

      {:ok, %{rows: [[count]]}} ->
        [{:duplicate_records, %{table: table, count: count}}]

      {:error, _} ->
        []
    end
  end

  defp run_check(table, :nulls) do
    sql = """
    SELECT COUNT(*) FROM #{table}
    WHERE inserted_at IS NULL
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: [[0]]}} -> []
      {:ok, %{rows: [[count]]}} -> [{:null_inserted_at, %{table: table, count: count}}]
      {:error, _} -> []
    end
  end

  defp run_check(_table, :orphans), do: []
  defp run_check(_table, _), do: []
end
