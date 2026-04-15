defmodule TeamJay.Investment.Phase5ModeReport do
  @moduledoc """
  Phase 5-E suite 결과를 사람이 읽기 쉬운 텍스트로 정리하는 helper.
  """

  alias TeamJay.Investment.Phase5ModeSuite

  def run_defaults(opts \\ []) do
    result = Phase5ModeSuite.run_defaults(opts)
    %{summary: render(result), result: result}
  end

  def render(result) do
    header =
      if result.all_ok do
        "Phase 5-E dynamic mode OK (#{result.passed}/#{result.total})"
      else
        "Phase 5-E dynamic mode CHECK (#{result.passed}/#{result.total})"
      end

    lines =
      Enum.map(result.rows, fn row ->
        "#{row.exchange} | #{row.symbol} | status=#{row.status} | completed=#{row.completed} | mode_persisted=#{row.mode_persisted_count} | profile_persisted=#{row.profile_persisted_count} | last=#{row.last_topic}"
      end)

    Enum.join([header | lines], "\n")
  end
end
