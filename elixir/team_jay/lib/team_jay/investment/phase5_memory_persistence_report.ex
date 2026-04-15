defmodule TeamJay.Investment.Phase5MemoryPersistenceReport do
  @moduledoc """
  Phase 5-D 메모리/성찰 DB persistence 검증 결과를 텍스트로 정리한다.
  """

  alias TeamJay.Investment.Phase5MemorySuite

  def run_defaults(opts \\ []) do
    result = Phase5MemorySuite.run_defaults(opts)

    persistence_result =
      Map.put(result, :all_ok, Enum.all?(result.rows, &persisted_row?/1))
      |> Map.put(:passed, Enum.count(result.rows, &persisted_row?/1))
      |> Map.put(:failed, Enum.count(result.rows, &(not persisted_row?(&1))))

    %{
      summary: render(persistence_result),
      result: persistence_result
    }
  end

  def render(result) do
    header =
      if result.all_ok do
        "Phase 5-D memory persistence OK (#{result.passed}/#{result.total})"
      else
        "Phase 5-D memory persistence CHECK (#{result.passed}/#{result.total})"
      end

    lines =
      Enum.map(result.rows, fn row ->
        "#{row.exchange} | #{row.symbol} | status=#{row.status} | completed=#{row.completed} | memory_persist_status=#{row.memory_persist_status} | reflection_persist_status=#{row.reflection_persist_status}"
      end)

    Enum.join([header | lines], "\n")
  end

  defp persisted_row?(%{
         status: :ok,
         completed: true,
         memory_persisted_count: memory_count,
         reflection_persisted_count: reflection_count
       })
       when memory_count > 0 and reflection_count > 0,
       do: true

  defp persisted_row?(_row), do: false
end
