defmodule TeamJay.Investment.Phase5ModePersistenceReport do
  @moduledoc """
  Phase 5-E mode/profile DB persistence 검증 결과를 텍스트로 정리한다.
  """

  alias TeamJay.Investment.Phase5ModeSuite

  def run_defaults(opts \\ []) do
    result = Phase5ModeSuite.run_defaults(opts)

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
        "Phase 5-E mode/profile persistence OK (#{result.passed}/#{result.total})"
      else
        "Phase 5-E mode/profile persistence CHECK (#{result.passed}/#{result.total})"
      end

    lines =
      Enum.map(result.rows, fn row ->
        "#{row.exchange} | #{row.symbol} | status=#{row.status} | completed=#{row.completed} | mode_persist_status=#{row.mode_persist_status} | profile_persist_status=#{row.profile_persist_status}"
      end)

    Enum.join([header | lines], "\n")
  end

  defp persisted_row?(%{
         status: :ok,
         completed: true,
         mode_persisted_count: mode_count,
         profile_persisted_count: profile_count
       })
       when mode_count > 0 and profile_count > 0,
       do: true

  defp persisted_row?(_row), do: false
end
