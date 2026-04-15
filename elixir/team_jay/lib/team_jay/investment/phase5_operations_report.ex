defmodule TeamJay.Investment.Phase5OperationsReport do
  @moduledoc """
  Phase 5 operations 상태를 사람이 읽기 쉬운 텍스트로 정리한다.
  """

  alias TeamJay.Investment.Phase5OperationsSuite

  def run_defaults(opts \\ []) do
    result = Phase5OperationsSuite.run_defaults(opts)
    %{summary: render(result), result: result}
  end

  def render(result) do
    header =
      case result.status do
        :phase5_operations_advanced -> "Phase 5 operations ADVANCED"
        :phase5_operations_ready -> "Phase 5 operations READY"
        :phase5_operations_stable -> "Phase 5 operations STABLE"
        _ -> "Phase 5 operations CHECK"
      end

    lines = [
      "mission_control=#{Atom.to_string(result.mission_control.status)}",
      "executive=#{Atom.to_string(result.executive.status)}",
      "closeout=#{Atom.to_string(result.closeout.status)}",
      "diagnostics=#{Atom.to_string(result.diagnostics.severity)}",
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
