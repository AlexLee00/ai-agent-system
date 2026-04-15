defmodule TeamJay.Investment.Phase5TrendHistoryReport do
  @moduledoc """
  Phase 5 trend 변화 상태를 사람이 읽기 쉬운 텍스트로 정리한다.
  """

  alias TeamJay.Investment.Phase5TrendHistory

  def run_defaults(opts \\ []) do
    result = Phase5TrendHistory.run_defaults(opts)
    %{summary: render(result), result: result}
  end

  def render(result) do
    header =
      case result.status do
        :phase5_trending_up -> "Phase 5 trend history UP"
        :phase5_stable -> "Phase 5 trend history STABLE"
        _ -> "Phase 5 trend history CHECK"
      end

    lines = [
      "status=#{Atom.to_string(result.status)}",
      "previous_status=#{render_previous_status(result.previous_status)}",
      "ready=#{status_word(result.ready)}",
      "transitioned=#{boolean_word(result.transitioned)}",
      "total_delta_rows=#{signed_int(result.total_delta_rows)}",
      "delta_from_previous=#{signed_int(result.delta_from_previous)}",
      "positive_tables=#{result.positive_tables}",
      "stagnant_tables=#{result.stagnant_tables}",
      "negative_tables=#{result.negative_tables}"
    ]

    Enum.join([header | lines], "\n")
  end

  defp render_previous_status(nil), do: "none"
  defp render_previous_status(status), do: Atom.to_string(status)

  defp status_word(true), do: "ok"
  defp status_word(false), do: "check"

  defp boolean_word(true), do: "yes"
  defp boolean_word(false), do: "no"

  defp signed_int(int) when int > 0, do: "+#{int}"
  defp signed_int(int), do: Integer.to_string(int)
end
