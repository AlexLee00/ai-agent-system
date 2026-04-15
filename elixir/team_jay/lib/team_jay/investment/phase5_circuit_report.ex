defmodule TeamJay.Investment.Phase5CircuitReport do
  @moduledoc """
  Phase 5.5-5 suite 결과를 사람이 읽기 쉬운 텍스트로 정리하는 helper.
  """

  alias TeamJay.Investment.Phase5CircuitSuite

  def run_defaults(opts \\ []) do
    result = Phase5CircuitSuite.run_defaults(opts)
    %{summary: render(result), result: result}
  end

  def render(result) do
    header =
      if result.all_ok do
        "Phase 5.5-5 circuit breaker OK (#{result.passed}/#{result.total})"
      else
        "Phase 5.5-5 circuit breaker CHECK (#{result.passed}/#{result.total})"
      end

    lines =
      Enum.map(result.rows, fn row ->
        status = row.circuit_status

        "#{row.exchange} | #{row.symbol} | status=#{row.status} | completed=#{row.completed} | events=#{row.event_count} | level=#{status.current_level} | paper=#{status.paper_mode} | auto_release=#{status.auto_release_count}"
      end)

    Enum.join([header | lines], "\n")
  end
end
