defmodule TeamJay.Investment.Phase5FullReport do
  @moduledoc """
  Phase 5 전체 suite 결과를 사람이 읽기 쉬운 텍스트로 정리하는 helper.
  """

  alias TeamJay.Investment.Phase5FullSuite

  def run_defaults(opts \\ []) do
    result = Phase5FullSuite.run_defaults(opts)
    %{summary: render(result), result: result}
  end

  def render(result) do
    header =
      if result.all_ok do
        "Phase 5 full scaffold OK"
      else
        "Phase 5 full scaffold CHECK"
      end

    lines = [
      summarize("5-A", result.phases.phase5_a),
      summarize("5-B", result.phases.phase5_b),
      summarize("5-C", result.phases.phase5_c),
      summarize("5.5-4", result.phases.phase5_5_4),
      summarize("5-D", result.phases.phase5_d),
      summarize("5-E", result.phases.phase5_e)
    ]

    Enum.join([header | lines], "\n")
  end

  defp summarize(label, result) do
    rows = Map.get(result, :rows, [])

    total =
      Map.get_lazy(result, :total, fn ->
        length(rows)
      end)

    passed =
      Map.get_lazy(result, :passed, fn ->
        count_passed_rows(rows)
      end)

    all_ok = Map.get(result, :all_ok, false)
    status = if all_ok, do: "ok", else: "check"
    "#{label} | status=#{status} | passed=#{passed}/#{total}"
  end

  defp count_passed_rows(rows) do
    Enum.count(rows, fn row ->
      case row do
        %{status: :ok, completed: true} -> true
        %{status: :ok} -> true
        _ -> false
      end
    end)
  end
end
