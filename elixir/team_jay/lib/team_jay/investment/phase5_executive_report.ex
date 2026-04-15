defmodule TeamJay.Investment.Phase5ExecutiveReport do
  @moduledoc """
  Phase 5 executive 상태를 사람이 읽기 쉬운 텍스트로 정리한다.
  """

  alias TeamJay.Investment.Phase5ExecutiveSuite

  def run_defaults(opts \\ []) do
    result = Phase5ExecutiveSuite.run_defaults(opts)
    %{summary: render(result), result: result}
  end

  def render(result) do
    header =
      case result.status do
        :phase5_executive_advanced -> "Phase 5 executive ADVANCED"
        :phase5_executive_ready -> "Phase 5 executive READY"
        :phase5_executive_stable -> "Phase 5 executive STABLE"
        _ -> "Phase 5 executive CHECK"
      end

    lines = [
      "command_center=#{Atom.to_string(result.command_center.status)}",
      "command_center_history=#{Atom.to_string(result.command_center_history.status)}",
      "control_tower=#{Atom.to_string(result.control_tower.status)}",
      "overview=#{Atom.to_string(result.overview.status)}",
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
