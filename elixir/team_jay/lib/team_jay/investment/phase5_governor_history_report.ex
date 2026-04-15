defmodule TeamJay.Investment.Phase5GovernorHistoryReport do
  @moduledoc """
  Phase 5 governor history 상태를 사람이 읽기 쉬운 텍스트로 정리한다.
  """

  alias TeamJay.Investment.Phase5GovernorHistory

  def run_defaults(opts \\ []) do
    result = Phase5GovernorHistory.run_defaults(opts)
    %{summary: render(result), result: result}
  end

  def render(result) do
    header =
      case result.status do
        :phase5_governor_advanced -> "Phase 5 governor history ADVANCED"
        :phase5_governor_ready -> "Phase 5 governor history READY"
        :phase5_governor_stable -> "Phase 5 governor history STABLE"
        _ -> "Phase 5 governor history CHECK"
      end

    lines = [
      "status=#{Atom.to_string(result.status)}",
      "previous_status=#{format_previous(result.previous_status)}",
      "ready=#{status_word(result.ready)}",
      "transitioned=#{status_word(result.transitioned)}",
      "blockers=#{format_blockers(result.blockers)}",
      "blocker_delta=#{result.blocker_delta}"
    ]

    Enum.join([header | lines], "\n")
  end

  defp format_previous(nil), do: "none"
  defp format_previous(value) when is_atom(value), do: Atom.to_string(value)

  defp status_word(true), do: "ok"
  defp status_word(false), do: "check"

  defp format_blockers([]), do: "none"
  defp format_blockers(blockers), do: Enum.join(blockers, ",")
end
