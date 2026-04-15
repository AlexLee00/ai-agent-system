defmodule TeamJay.Investment.Phase5AutonomyPersistenceReport do
  @moduledoc """
  Phase 5.5-9 autonomous loop DB persistence 검증 결과를 텍스트로 정리한다.
  """

  alias TeamJay.Investment.Phase5AutonomySuite

  def run_defaults(opts \\ []) do
    result = Phase5AutonomySuite.run_defaults(opts)

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
        "Phase 5.5-9 autonomous loop persistence OK (#{result.passed}/#{result.total})"
      else
        "Phase 5.5-9 autonomous loop persistence CHECK (#{result.passed}/#{result.total})"
      end

    lines =
      Enum.map(result.rows, fn row ->
        "#{Map.get(row, :exchange)} | #{Map.get(row, :symbol)} | status=#{Map.get(row, :status)} | completed=#{Map.get(row, :completed)} | persisted=#{Map.get(row, :persisted_count, 0)} | persist_status=#{Map.get(row, :persist_status, :idle)}"
      end)

    Enum.join([header | lines], "\n")
  end

  defp persisted_row?(%{
         status: :ok,
         completed: true,
         persisted_count: persisted_count
       })
       when persisted_count > 0,
       do: true

  defp persisted_row?(_row), do: false
end
