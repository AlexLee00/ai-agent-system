defmodule TeamJay.Investment.Phase5MemoryReport do
  @moduledoc """
  Phase 5-D suite 결과를 사람이 읽기 쉬운 텍스트로 정리하는 helper.
  """

  alias TeamJay.Investment.Phase5MemorySuite

  def run_defaults(opts \\ []) do
    result = Phase5MemorySuite.run_defaults(opts)
    %{summary: render(result), result: result}
  end

  def render(result) do
    header =
      if result.all_ok do
        "Phase 5-D memory reflection OK (#{result.passed}/#{result.total})"
      else
        "Phase 5-D memory reflection CHECK (#{result.passed}/#{result.total})"
      end

    lines =
      Enum.map(result.rows, fn row ->
        "#{row.exchange} | #{row.symbol} | status=#{row.status} | completed=#{row.completed} | memory_persisted=#{row.memory_persisted_count} | reflection_persisted=#{row.reflection_persisted_count} | last=#{row.last_topic}"
      end)

    Enum.join([header | lines], "\n")
  end
end
