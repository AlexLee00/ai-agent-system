defmodule TeamJay.Investment.Phase5OverrideReport do
  @moduledoc """
  Phase 5.5-4 suite 결과를 사람이 읽기 쉬운 텍스트로 정리하는 helper.
  """

  alias TeamJay.Investment.Phase5OverrideSuite

  def run_defaults(opts \\ []) do
    result = Phase5OverrideSuite.run_defaults(opts)

    %{
      summary: render(result),
      result: result
    }
  end

  def render(result) do
    header =
      if result.all_ok do
        "Phase 5.5-4 runtime overrides OK (#{result.passed}/#{result.total})"
      else
        "Phase 5.5-4 runtime overrides CHECK (#{result.passed}/#{result.total})"
      end

    lines =
      Enum.map(result.rows, fn row ->
        "#{row.exchange} | #{row.symbol} | status=#{row.status} | completed=#{row.completed} | events=#{row.event_count} | last=#{row.last_topic}"
      end)

    Enum.join([header | lines], "\n")
  end
end
