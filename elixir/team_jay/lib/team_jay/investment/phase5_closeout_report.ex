defmodule TeamJay.Investment.Phase5CloseoutReport do
  @moduledoc """
  Phase 5 closeout readiness를 사람이 읽기 쉬운 텍스트로 정리한다.
  """

  alias TeamJay.Investment.Phase5CloseoutSuite

  def run_defaults(opts \\ []) do
    result = Phase5CloseoutSuite.run_defaults(opts)
    %{summary: render(result), result: result}
  end

  def render(result) do
    header =
      case result.status do
        :phase5_ready_to_close -> "Phase 5 closeout READY"
        _ -> "Phase 5 closeout IN PROGRESS"
      end

    lines = [
      "full_scaffold=#{status_word(result.full.all_ok)}",
      "persistence=#{status_word(result.persistence.all_ok)}",
      "operations=#{status_word(result.operations.ready)}",
      "governor=#{status_word(result.governor.ready)}",
      "blockers=#{render_blockers(result.blockers)}"
    ]

    Enum.join([header | lines], "\n")
  end

  defp render_blockers([]), do: "none"
  defp render_blockers(blockers), do: blockers |> Enum.reverse() |> Enum.map(&Atom.to_string/1) |> Enum.join(", ")

  defp status_word(true), do: "ok"
  defp status_word(false), do: "check"
end
