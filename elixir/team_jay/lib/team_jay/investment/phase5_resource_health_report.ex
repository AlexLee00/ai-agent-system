defmodule TeamJay.Investment.Phase5ResourceHealthReport do
  @moduledoc """
  Phase 5 resource health suite 결과를 사람이 읽기 쉬운 텍스트로 정리하는 helper.
  """

  alias TeamJay.Investment.Phase5ResourceHealthSuite

  def run_defaults(opts \\ []) do
    result = Phase5ResourceHealthSuite.run_defaults(opts)
    %{summary: render(result), result: result}
  end

  def render(result) do
    header =
      if result.all_ok do
        "Phase 5 resource health OK (#{result.passed}/#{result.total})"
      else
        "Phase 5 resource health CHECK (#{result.passed}/#{result.total})"
      end

    lines =
      Enum.map(result.rows, fn row ->
        health =
          row.events
          |> Enum.reverse()
          |> Enum.find_value(fn
            %{payload: {:resource_health, payload}} -> payload
            _ -> nil
          end)

        status = if health, do: health.status, else: :unknown
        score = if health, do: :erlang.float_to_binary(health.health_score, decimals: 2), else: "0.00"
        action = if health, do: health.action, else: :unknown
        "#{row.exchange} | #{row.symbol} | status=#{row.status} | completed=#{row.completed} | health=#{status} | score=#{score} | action=#{action}"
      end)

    Enum.join([header | lines], "\n")
  end
end
