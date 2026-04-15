defmodule TeamJay.Investment.Phase5Report do
  @moduledoc """
  Phase 5-A suite 결과를 사람이 읽기 쉬운 텍스트로 정리하는 helper.
  """

  alias TeamJay.Investment.Phase5Suite

  def run_defaults(opts \\ []) do
    result = Phase5Suite.run_defaults(opts)
    %{
      summary: render(result),
      result: result
    }
  end

  def render(result) do
    header =
      if result.all_ok do
        "Phase 5-A position loop OK (#{result.passed}/#{result.total})"
      else
        "Phase 5-A position loop CHECK (#{result.passed}/#{result.total})"
      end

    lines =
      Enum.map(result.rows, fn row ->
        "#{row.exchange} | #{row.symbol} | status=#{row.status} | completed=#{row.completed} | events=#{row.event_count} | last=#{row.last_topic}"
      end)

    Enum.join([header | lines], "\n")
  end
end
