defmodule TeamJay.Investment.Phase5AutonomyReport do
  @moduledoc """
  Phase 5.5-9 suite 결과를 사람이 읽기 쉬운 텍스트로 정리하는 helper.
  """

  alias TeamJay.Investment.Phase5AutonomySuite

  def run_defaults(opts \\ []) do
    result = Phase5AutonomySuite.run_defaults(opts)
    %{summary: render(result), result: result}
  end

  def render(result) do
    header =
      if result.all_ok do
        "Phase 5.5-9 autonomous loop OK (#{result.passed}/#{result.total})"
      else
        "Phase 5.5-9 autonomous loop CHECK (#{result.passed}/#{result.total})"
      end

    lines =
      Enum.map(result.rows, fn row ->
        cycle =
          row.events
          |> Enum.reverse()
          |> Enum.find_value(fn
            %{payload: {:autonomous_cycle, payload}} -> payload
            _ -> nil
          end)

        action = if cycle, do: cycle.action, else: :unknown
        readiness = if cycle, do: cycle.readiness, else: :unknown
        mode = if cycle, do: cycle.mode, else: :unknown
        "#{row.exchange} | #{row.symbol} | status=#{row.status} | completed=#{row.completed} | mode=#{mode} | action=#{action} | readiness=#{readiness}"
      end)

    Enum.join([header | lines], "\n")
  end
end
