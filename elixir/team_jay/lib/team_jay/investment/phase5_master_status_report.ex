defmodule TeamJay.Investment.Phase5MasterStatusReport do
  @moduledoc """
  Phase 5 상위 상태를 사람이 읽기 쉬운 텍스트로 정리한다.
  """

  alias TeamJay.Investment.Phase5MasterStatusSuite

  def run_defaults(opts \\ []) do
    result = Phase5MasterStatusSuite.run_defaults(opts)
    %{summary: render(result), result: result}
  end

  def render(result) do
    header =
      case result.status do
        :phase5_master_advanced -> "Phase 5 master status ADVANCED"
        :phase5_master_ready -> "Phase 5 master status READY"
        _ -> "Phase 5 master status CHECK"
      end

    lines = [
      "full_scaffold=#{status_word(result.full.all_ok)}",
      "persistence=#{status_word(result.persistence.all_ok)}",
      "closeout=#{status_word(result.closeout.ready)}",
      "history=#{status_word(result.history.ready)}",
      "transitioned=#{boolean_word(result.history.transitioned)}",
      "blockers=#{render_blockers(result.blockers)}"
    ]

    Enum.join([header | lines], "\n")
  end

  defp render_blockers([]), do: "none"
  defp render_blockers(blockers), do: blockers |> Enum.reverse() |> Enum.map(&Atom.to_string/1) |> Enum.join(", ")

  defp status_word(true), do: "ok"
  defp status_word(false), do: "check"

  defp boolean_word(true), do: "yes"
  defp boolean_word(false), do: "no"
end
