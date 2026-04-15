defmodule TeamJay.Investment.Phase5LoopReport do
  @moduledoc """
  Phase 5-B loop harness 결과를 읽기 쉬운 텍스트로 정리한다.
  """

  alias TeamJay.Investment.Phase5LoopHarness
  alias TeamJay.Investment.PipelineStarter

  def run_defaults(opts \\ []) do
    interval_ms = Keyword.get(opts, :interval_ms, 150)
    timeout_ms = Keyword.get(opts, :timeout_ms, 6_000)

    rows =
      Enum.map(PipelineStarter.default_pipelines(), fn %{exchange: exchange, symbol: symbol} ->
        result =
          Phase5LoopHarness.run_once(
            exchange: exchange,
            symbol: symbol,
            interval_ms: interval_ms,
            timeout_ms: timeout_ms
          )

        Map.merge(%{exchange: exchange, symbol: symbol}, result)
      end)

    header =
      if Enum.all?(rows, &(&1.status == :ok and &1.completed)) do
        "Phase 5-B trading loop OK (#{length(rows)}/#{length(rows)})"
      else
        "Phase 5-B trading loop CHECK"
      end

    summary =
      Enum.map(rows, fn row ->
        "#{row.exchange} | #{row.symbol} | status=#{row.status} | completed=#{row.completed} | events=#{row.event_count} | last=#{row.last_topic}"
      end)
      |> then(&Enum.join([header | &1], "\n"))

    %{
      summary: summary,
      rows: rows,
      all_ok: Enum.all?(rows, &(&1.status == :ok and &1.completed))
    }
  end
end
