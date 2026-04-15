defmodule TeamJay.Investment.Phase5ControlTowerReport do
  @moduledoc """
  Phase 5 control tower 상태를 사람이 읽기 쉬운 텍스트로 정리한다.
  """

  alias TeamJay.Investment.Phase5ControlTowerSuite

  def run_defaults(opts \\ []) do
    result = Phase5ControlTowerSuite.run_defaults(opts)
    %{summary: render(result), result: result}
  end

  def render(result) do
    header =
      case result.status do
        :phase5_control_tower_advanced -> "Phase 5 control tower ADVANCED"
        :phase5_control_tower_ready -> "Phase 5 control tower READY"
        :phase5_control_tower_stable -> "Phase 5 control tower STABLE"
        _ -> "Phase 5 control tower CHECK"
      end

    lines = [
      "overview=#{Atom.to_string(result.overview.status)}",
      "overview_history=#{Atom.to_string(result.overview_history.status)}",
      "dashboard=#{Atom.to_string(result.dashboard.status)}",
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
