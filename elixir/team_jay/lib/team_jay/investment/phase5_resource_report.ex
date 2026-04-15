defmodule TeamJay.Investment.Phase5ResourceReport do
  @moduledoc """
  Phase 5.5-8 suite 결과를 사람이 읽기 쉬운 텍스트로 정리하는 helper.
  """

  alias TeamJay.Investment.Phase5ResourceSuite

  def run_defaults(opts \\ []) do
    result = Phase5ResourceSuite.run_defaults(opts)
    %{summary: render(result), result: result}
  end

  def render(result) do
    header =
      if result.all_ok do
        "Phase 5.5-8 resource feedback OK (#{result.passed}/#{result.total})"
      else
        "Phase 5.5-8 resource feedback CHECK (#{result.passed}/#{result.total})"
      end

    lines =
      Enum.map(result.rows, fn row ->
        resource =
          row.events
          |> Enum.reverse()
          |> Enum.find_value(fn
            %{payload: {:resource_feedback, payload}} -> payload
            _ -> nil
          end)

        ready_resources = if resource, do: resource.ready_resources, else: 0
        recommendation = if resource, do: resource.recommendation, else: :unknown
        "#{row.exchange} | #{row.symbol} | status=#{row.status} | completed=#{row.completed} | resources=#{ready_resources} | recommendation=#{recommendation}"
      end)

    Enum.join([header | lines], "\n")
  end
end
