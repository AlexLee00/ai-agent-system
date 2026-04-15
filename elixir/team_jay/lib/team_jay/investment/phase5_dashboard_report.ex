defmodule TeamJay.Investment.Phase5DashboardReport do
  @moduledoc """
  Phase 5 dashboard 상태를 사람이 읽기 쉬운 텍스트로 정리한다.
  """

  alias TeamJay.Investment.Phase5DashboardSuite

  def run_defaults(opts \\ []) do
    result = Phase5DashboardSuite.run_defaults(opts)
    %{summary: render(result), result: result}
  end

  def render(result) do
    header =
      case result.status do
        :phase5_dashboard_advanced -> "Phase 5 dashboard ADVANCED"
        :phase5_dashboard_ready -> "Phase 5 dashboard READY"
        :phase5_dashboard_stable -> "Phase 5 dashboard STABLE"
        _ -> "Phase 5 dashboard CHECK"
      end

    lines = [
      "full=#{status_word(result.full.all_ok)}",
      "persistence=#{status_word(result.persistence.all_ok)}",
      "closeout=#{status_word(result.closeout.ready)}",
      "master=#{Atom.to_string(result.master.status)}",
      "trend=#{Atom.to_string(result.trend.status)}",
      "master_trend=#{Atom.to_string(result.master_trend.status)}",
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
