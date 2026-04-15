defmodule TeamJay.Investment.Phase5OverridePersistenceReport do
  @moduledoc """
  Phase 5.5-4 DB materialization suite 결과를 사람이 읽기 쉬운 텍스트로 정리한다.
  """

  alias TeamJay.Investment.Phase5OverridePersistenceSuite

  def run_defaults(opts \\ []) do
    result = Phase5OverridePersistenceSuite.run_defaults(opts)

    %{
      summary: render(result),
      result: result
    }
  end

  def render(result) do
    header =
      if result.all_ok do
        "Phase 5.5-4 runtime override DB persistence OK (#{result.passed}/#{result.total})"
      else
        "Phase 5.5-4 runtime override DB persistence CHECK (#{result.passed}/#{result.total})"
      end

    lines =
      Enum.map(result.rows, fn row ->
        "#{row.exchange} | #{row.symbol} | status=#{row.status} | completed=#{row.completed} | persisted=#{row.persisted_count} | persist_status=#{row.persist_status}"
      end)

    Enum.join([header | lines], "\n")
  end
end
