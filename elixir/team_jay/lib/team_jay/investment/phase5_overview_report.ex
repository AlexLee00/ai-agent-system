defmodule TeamJay.Investment.Phase5OverviewReport do
  @moduledoc """
  Phase 5 overview 상태를 사람이 읽기 쉬운 텍스트로 정리한다.
  """

  alias TeamJay.Investment.Phase5OverviewSuite

  def run_defaults(opts \\ []) do
    result = Phase5OverviewSuite.run_defaults(opts)
    %{summary: render(result), result: result}
  end

  def render(result) do
    header =
      case result.status do
        :phase5_overview_advanced -> "Phase 5 overview ADVANCED"
        :phase5_overview_ready -> "Phase 5 overview READY"
        :phase5_overview_stable -> "Phase 5 overview STABLE"
        _ -> "Phase 5 overview CHECK"
      end

    lines = [
      "dashboard=#{Atom.to_string(result.dashboard.status)}",
      "dashboard_history=#{Atom.to_string(result.dashboard_history.status)}",
      "master_trend=#{Atom.to_string(result.master_trend.status)}",
      "closeout=#{Atom.to_string(result.closeout.status)}",
      "blockers=#{format_blockers(result.blockers)}",
      "ready=#{status_word(result.ready)}"
    ]

    Enum.join([header | lines], "\n")
  end

  defp status_word(true), do: "ok"
  defp status_word(false), do: "check"

  defp format_blockers([]), do: "none"
  defp format_blockers(blockers), do: blockers |> Enum.map(&Atom.to_string/1) |> Enum.join(",")
end
