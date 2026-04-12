defmodule TeamJay.Investment.PipelineScenarioReport do
  @moduledoc """
  투자팀 Elixir scaffold scenario suite 결과를 요약하는 report helper.

  기본 심볼 세트 점검 결과를 텍스트/맵 형태로 정리해서
  현재 scaffold 기준선을 빠르게 읽는 용도다.
  """

  alias TeamJay.Investment.PipelineScenarioSuite

  def run_defaults(opts \\ []) do
    suite = PipelineScenarioSuite.run_defaults(opts)

    Map.put(suite, :report, render_report(suite))
  end

  def render_report(%{total: total, passed: passed, failed: failed, all_ok: all_ok, results: results}) do
    headline =
      if all_ok do
        "Investment scaffold suite OK (#{passed}/#{total})"
      else
        "Investment scaffold suite needs attention (passed #{passed}/#{total}, failed #{failed})"
      end

    details =
      Enum.map(results, fn result ->
        summary = result.summary

        [
          result.exchange,
          result.symbol,
          "probe=#{bool_mark(summary.probe_ok)}",
          "pipeline=#{bool_mark(summary.pipeline_ok)}",
          "feedback=#{bool_mark(summary.feedback_ok)}",
          "events=#{summary.event_count}",
          "feedbacks=#{summary.feedback_count}"
        ]
        |> Enum.join(" | ")
      end)

    Enum.join([headline | details], "\n")
  end

  defp bool_mark(true), do: "ok"
  defp bool_mark(false), do: "fail"
end
