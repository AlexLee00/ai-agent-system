defmodule TeamJay.Investment.Phase5MasterTrendReport do
  @moduledoc """
  Phase 5 master trend를 사람이 읽기 쉬운 텍스트로 정리한다.
  """

  alias TeamJay.Investment.Phase5MasterTrendSuite

  def run_defaults(opts \\ []) do
    result = Phase5MasterTrendSuite.run_defaults(opts)
    %{summary: render(result), result: result}
  end

  def render(result) do
    header =
      case result.status do
        :phase5_master_trending_advanced -> "Phase 5 master trend ADVANCED"
        :phase5_master_trending_up -> "Phase 5 master trend UP"
        :phase5_master_trend_stable -> "Phase 5 master trend STABLE"
        _ -> "Phase 5 master trend CHECK"
      end

    lines = [
      "master_status=#{Atom.to_string(result.master.status)}",
      "trend_status=#{Atom.to_string(result.trend_status)}",
      "blocker_count=#{result.blocker_count}",
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

  defp signed_int(int) when int > 0, do: "+#{int}"
  defp signed_int(int), do: Integer.to_string(int)
end
