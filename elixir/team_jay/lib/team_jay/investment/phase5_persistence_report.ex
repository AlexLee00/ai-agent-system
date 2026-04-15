defmodule TeamJay.Investment.Phase5PersistenceReport do
  @moduledoc """
  Phase 5 persistence 상태를 사람이 읽기 쉬운 텍스트로 정리한다.
  """

  alias TeamJay.Investment.Phase5PersistenceSuite

  def run_defaults(opts \\ []) do
    result = Phase5PersistenceSuite.run_defaults(opts)
    %{summary: render(result), result: result}
  end

  def render(result) do
    header =
      if result.all_ok do
        "Phase 5 persistence summary OK (#{result.passed}/#{result.total})"
      else
        "Phase 5 persistence summary CHECK (#{result.passed}/#{result.total})"
      end

    lines =
      Enum.map(result.rows, fn row ->
        "#{row.label} | table=#{row.table} | status=#{row.status} | rows=#{row.row_count} | symbols=#{row.symbol_count}"
      end)

    Enum.join([header | lines], "\n")
  end
end
