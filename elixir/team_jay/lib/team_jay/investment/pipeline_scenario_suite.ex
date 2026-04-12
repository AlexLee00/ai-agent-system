defmodule TeamJay.Investment.PipelineScenarioSuite do
  @moduledoc """
  투자팀 Elixir scaffold scenario를 기본 심볼 세트로 일괄 점검하는 helper.

  각 기본 pipeline에 대해 scenario를 순차 실행하고, 전체 성공 여부와
  간단한 집계 결과를 함께 반환한다.
  """

  alias TeamJay.Investment.PipelineScenario
  alias TeamJay.Investment.PipelineStarter

  @default_interval_ms 250
  @default_timeout 2_000

  def run_defaults(opts \\ []) do
    interval_ms = Keyword.get(opts, :interval_ms, @default_interval_ms)
    timeout_ms = Keyword.get(opts, :timeout_ms, @default_timeout)

    results =
      Enum.map(PipelineStarter.default_pipelines(), fn %{exchange: exchange, symbol: symbol} ->
        PipelineScenario.run_once(
          exchange: exchange,
          symbol: symbol,
          interval_ms: interval_ms,
          timeout_ms: timeout_ms
        )
      end)

    %{
      total: length(results),
      passed: Enum.count(results, &scenario_ok?/1),
      failed: Enum.count(results, &(not scenario_ok?(&1))),
      all_ok: Enum.all?(results, &scenario_ok?/1),
      results: results
    }
  end

  defp scenario_ok?(%{
         summary: %{
           probe_ok: true,
           pipeline_ok: true,
           feedback_ok: true
         }
       }),
       do: true

  defp scenario_ok?(_other), do: false
end
