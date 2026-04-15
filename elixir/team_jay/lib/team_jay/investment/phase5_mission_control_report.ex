defmodule TeamJay.Investment.Phase5MissionControlReport do
  @moduledoc """
  Phase 5 mission control 상태를 사람이 읽기 쉬운 텍스트로 정리한다.
  """

  alias TeamJay.Investment.Phase5MissionControlSuite

  def run_defaults(opts \\ []) do
    result = Phase5MissionControlSuite.run_defaults(opts)
    %{summary: render(result), result: result}
  end

  def render(result) do
    header =
      case result.status do
        :phase5_mission_control_advanced -> "Phase 5 mission control ADVANCED"
        :phase5_mission_control_ready -> "Phase 5 mission control READY"
        :phase5_mission_control_stable -> "Phase 5 mission control STABLE"
        _ -> "Phase 5 mission control CHECK"
      end

    lines = [
      "executive=#{Atom.to_string(result.executive.status)}",
      "command_center=#{Atom.to_string(result.command_center.status)}",
      "resource_health=#{Atom.to_string(result.resource_health.status)}",
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
