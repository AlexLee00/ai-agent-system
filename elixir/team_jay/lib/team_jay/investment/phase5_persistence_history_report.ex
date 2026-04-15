defmodule TeamJay.Investment.Phase5PersistenceHistoryReport do
  @moduledoc """
  Phase 5 persistence snapshot의 변화량을 사람이 읽기 쉬운 텍스트로 정리한다.
  """

  alias TeamJay.Investment.Phase5PersistenceHistory

  def run_defaults(opts \\ []) do
    result = Phase5PersistenceHistory.run_defaults(opts)
    %{summary: render(result), result: result}
  end

  def render(result) do
    header =
      if result.all_ok do
        "Phase 5 persistence history OK (#{result.passed}/#{result.total})"
      else
        "Phase 5 persistence history CHECK (#{result.passed}/#{result.total})"
      end

    lines =
      Enum.map(result.rows, fn row ->
        "#{row.label} | rows=#{row.row_count} (#{signed(row.delta_rows)}) | symbols=#{row.symbol_count} (#{signed(row.delta_symbols)}) | status=#{row.status}"
      end)

    Enum.join([header | lines], "\n")
  end

  defp signed(value) when value > 0, do: "+#{value}"
  defp signed(value), do: "#{value}"
end
