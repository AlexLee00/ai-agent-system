defmodule TeamJay.Investment.Phase5ControlTowerHistoryReport do
  @moduledoc """
  Phase 5 control tower history를 사람이 읽기 쉬운 텍스트로 정리한다.
  """

  alias TeamJay.Investment.Phase5ControlTowerHistory

  def run_defaults(opts \\ []) do
    result = Phase5ControlTowerHistory.run_defaults(opts)
    %{summary: render(result), result: result}
  end

  def render(result) do
    header =
      case result.status do
        :phase5_control_tower_advanced -> "Phase 5 control tower history ADVANCED"
        :phase5_control_tower_ready -> "Phase 5 control tower history READY"
        :phase5_control_tower_stable -> "Phase 5 control tower history STABLE"
        _ -> "Phase 5 control tower history CHECK"
      end

    lines = [
      "status=#{Atom.to_string(result.status)}",
      "previous_status=#{result.previous_status && Atom.to_string(result.previous_status) || "none"}",
      "ready=#{status_word(result.ready)}",
      "transitioned=#{boolean_word(result.transitioned)}",
      "blockers=#{format_blockers(result.blockers)}",
      "blocker_delta=#{signed_int(result.blocker_delta)}"
    ]

    Enum.join([header | lines], "\n")
  end

  defp status_word(true), do: "ok"
  defp status_word(false), do: "check"

  defp boolean_word(true), do: "yes"
  defp boolean_word(false), do: "no"

  defp format_blockers([]), do: "none"
  defp format_blockers(blockers), do: Enum.join(blockers, ",")

  defp signed_int(int) when int > 0, do: "+#{int}"
  defp signed_int(int), do: Integer.to_string(int)
end
