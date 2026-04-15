defmodule TeamJay.Investment.Phase5CommandCenterReport do
  @moduledoc """
  Phase 5 command center 상태를 사람이 읽기 쉬운 텍스트로 정리한다.
  """

  alias TeamJay.Investment.Phase5CommandCenterSuite

  def run_defaults(opts \\ []) do
    result = Phase5CommandCenterSuite.run_defaults(opts)
    %{summary: render(result), result: result}
  end

  def render(result) do
    header =
      case result.status do
        :phase5_command_center_advanced -> "Phase 5 command center ADVANCED"
        :phase5_command_center_ready -> "Phase 5 command center READY"
        :phase5_command_center_stable -> "Phase 5 command center STABLE"
        _ -> "Phase 5 command center CHECK"
      end

    lines = [
      "control_tower=#{Atom.to_string(result.control_tower.status)}",
      "control_tower_history=#{Atom.to_string(result.control_tower_history.status)}",
      "overview=#{Atom.to_string(result.overview.status)}",
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
