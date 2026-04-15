defmodule TeamJay.Investment.Phase5MemorySuite do
  @moduledoc """
  Phase 5-D memory/reflection scaffold를 기본 시장 세트로 검증하는 suite.
  """

  alias TeamJay.Investment.Phase5MemoryHarness
  alias TeamJay.Investment.PipelineStarter

  def run_defaults(opts \\ []) do
    interval_ms = Keyword.get(opts, :interval_ms, 150)
    timeout_ms = Keyword.get(opts, :timeout_ms, 6_000)

    rows =
      Enum.map(PipelineStarter.default_pipelines(), fn %{exchange: exchange, symbol: symbol} ->
        result =
          Phase5MemoryHarness.run_once(
            exchange: exchange,
            symbol: symbol,
            interval_ms: interval_ms,
            timeout_ms: timeout_ms
          )

        Map.merge(%{exchange: exchange, symbol: symbol}, result)
      end)

    %{
      total: length(rows),
      passed: Enum.count(rows, &(&1.status == :ok and &1.completed)),
      failed: Enum.count(rows, &not (&1.status == :ok and &1.completed)),
      all_ok: Enum.all?(rows, &(&1.status == :ok and &1.completed)),
      rows: rows
    }
  end
end
