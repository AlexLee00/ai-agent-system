defmodule TeamJay.Investment.PipelineScenario do
  @moduledoc """
  투자팀 Elixir scaffold를 한 번에 점검하는 상위 scenario helper.

  probe, pipeline harness, feedback harness 결과를 한 묶음으로 반환해서
  현재 scaffold가 어디까지 이어지는지 빠르게 확인하는 용도다.
  """

  alias TeamJay.Investment.Feedback.Harness, as: FeedbackHarness
  alias TeamJay.Investment.PipelineHarness
  alias TeamJay.Investment.PipelineProbe

  @default_timeout 2_000

  def run_once(opts \\ []) do
    exchange = Keyword.get(opts, :exchange, "binance")
    symbol = Keyword.get(opts, :symbol, "BTC/USDT")
    interval_ms = Keyword.get(opts, :interval_ms, 250)
    timeout_ms = Keyword.get(opts, :timeout_ms, @default_timeout)

    probe =
      PipelineProbe.probe(
        exchange: exchange,
        symbol: symbol,
        interval_ms: interval_ms,
        stop_after_probe: true
      )

    pipeline =
      PipelineHarness.run_once(
        exchange: exchange,
        symbol: symbol,
        interval_ms: interval_ms,
        timeout_ms: timeout_ms * 3
      )

    feedback =
      FeedbackHarness.run_once(
        symbol: symbol,
        timeout_ms: timeout_ms
      )

    %{
      exchange: exchange,
      symbol: symbol,
      probe: probe,
      pipeline: pipeline,
      feedback: feedback,
      summary: summarize(probe, pipeline, feedback)
    }
  end

  defp summarize(probe, pipeline, feedback) do
    %{
      probe_ok: probe.start_result.status in [:started, :already_started] and probe.inspection.pipeline.registered,
      pipeline_ok: pipeline.status == :ok and pipeline.completed == true,
      feedback_ok:
        feedback.entry_feedback.status == :ok and
          feedback.exit_feedback.status == :ok and
          feedback.exit_status.open_position_count == 0,
      event_count: pipeline.event_count,
      feedback_count: feedback.exit_status.feedback_count
    }
  end
end
