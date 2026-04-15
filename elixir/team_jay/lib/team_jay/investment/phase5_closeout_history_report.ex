defmodule TeamJay.Investment.Phase5CloseoutHistoryReport do
  @moduledoc """
  Phase 5 closeout 상태 변화를 사람이 읽기 쉬운 텍스트로 정리한다.
  """

  alias TeamJay.Investment.Phase5CloseoutHistory

  def run_defaults(opts \\ []) do
    result = Phase5CloseoutHistory.run_defaults(opts)
    %{summary: render(result), result: result}
  end

  def render(result) do
    header =
      case result.status do
        :phase5_ready_to_close -> "Phase 5 closeout history READY"
        _ -> "Phase 5 closeout history IN PROGRESS"
      end

    lines = [
      "status=#{Atom.to_string(result.status)}",
      "previous_status=#{render_previous_status(result.previous_status)}",
      "ready=#{status_word(result.ready)}",
      "transitioned=#{boolean_word(result.transitioned)}",
      "blockers=#{render_blockers(result.blockers)}",
      "blocker_delta=#{signed_int(result.blocker_delta)}"
    ]

    Enum.join([header | lines], "\n")
  end

  defp render_previous_status(nil), do: "none"
  defp render_previous_status(status), do: Atom.to_string(status)

  defp render_blockers([]), do: "none"
  defp render_blockers(blockers), do: blockers |> Enum.map(&Atom.to_string/1) |> Enum.join(", ")

  defp status_word(true), do: "ok"
  defp status_word(false), do: "check"

  defp boolean_word(true), do: "yes"
  defp boolean_word(false), do: "no"

  defp signed_int(int) when int > 0, do: "+#{int}"
  defp signed_int(int), do: Integer.to_string(int)
end
