defmodule TeamJay.Investment.Phase5GovernorReport do
  @moduledoc """
  Phase 5 governor 상태를 사람이 읽기 쉬운 텍스트로 정리한다.
  """

  alias TeamJay.Investment.Phase5GovernorSuite

  def run_defaults(opts \\ []) do
    result = Phase5GovernorSuite.run_defaults(opts)
    %{summary: render(result), result: result}
  end

  def render(result) do
    header =
      case result.status do
        :phase5_governor_advanced -> "Phase 5 governor ADVANCED"
        :phase5_governor_ready -> "Phase 5 governor READY"
        :phase5_governor_stable -> "Phase 5 governor STABLE"
        _ -> "Phase 5 governor CHECK"
      end

    lines = [
      "operations=#{Atom.to_string(result.operations.status)}",
      "operations_history=#{Atom.to_string(result.operations_history.status)}",
      "mission_control=#{Atom.to_string(result.mission_control.status)}",
      "closeout=#{Atom.to_string(result.closeout.status)}",
      "diagnostics=#{Atom.to_string(result.operations.diagnostics_severity)}",
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
