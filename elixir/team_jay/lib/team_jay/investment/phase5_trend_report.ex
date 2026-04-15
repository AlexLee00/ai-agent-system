defmodule TeamJay.Investment.Phase5TrendReport do
  @moduledoc """
  Phase 5 추세를 사람이 읽기 쉬운 텍스트로 정리한다.
  """

  alias TeamJay.Investment.Phase5TrendSuite

  def run_defaults(opts \\ []) do
    result = Phase5TrendSuite.run_defaults(opts)
    %{summary: render(result), result: result}
  end

  def render(result) do
    header =
      case result.status do
        :phase5_trending_up -> "Phase 5 trend UP"
        :phase5_stable -> "Phase 5 trend STABLE"
        _ -> "Phase 5 trend CHECK"
      end

    lines = [
      "master_status=#{Atom.to_string(result.master.status)}",
      "master_transitioned=#{boolean_word(result.master.transitioned)}",
      "total_delta_rows=#{signed_int(result.total_delta_rows)}",
      "positive_tables=#{result.positive_tables}",
      "stagnant_tables=#{result.stagnant_tables}",
      "negative_tables=#{result.negative_tables}",
      "ready=#{status_word(result.ready)}"
    ]

    Enum.join([header | lines], "\n")
  end

  defp status_word(true), do: "ok"
  defp status_word(false), do: "check"

  defp boolean_word(true), do: "yes"
  defp boolean_word(false), do: "no"

  defp signed_int(int) when int > 0, do: "+#{int}"
  defp signed_int(int), do: Integer.to_string(int)
end
