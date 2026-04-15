defmodule TeamJay.Investment.Phase5OverridePersistenceSuite do
  @moduledoc """
  Phase 5.5-4 DB materialization 검증용 suite.

  기본 시장 세트에 synthetic allow strategy_update를 주입해
  runtime override가 investment.runtime_overrides에 실제로 적재되는지 확인한다.
  """

  alias TeamJay.Investment.Phase5OverrideHarness
  alias TeamJay.Investment.PipelineStarter

  def run_defaults(opts \\ []) do
    interval_ms = Keyword.get(opts, :interval_ms, 150)
    timeout_ms = Keyword.get(opts, :timeout_ms, 6_000)

    rows =
      Enum.map(PipelineStarter.default_pipelines(), fn %{exchange: exchange, symbol: symbol} ->
        result =
          Phase5OverrideHarness.run_once(
            exchange: exchange,
            symbol: symbol,
            interval_ms: interval_ms,
            timeout_ms: timeout_ms,
            inject_update: injected_update(exchange)
          )

        Map.merge(%{exchange: exchange, symbol: symbol}, result)
      end)

    %{
      total: length(rows),
      passed: Enum.count(rows, &persisted_row?/1),
      failed: Enum.count(rows, &(not persisted_row?(&1))),
      all_ok: Enum.all?(rows, &persisted_row?/1),
      rows: rows
    }
  end

  defp injected_update("binance") do
    %{
      governance_tier: :allow,
      action: :adjust_position_size,
      reason: :crypto_persistence_smoke,
      proposals: %{
        position_size_delta: -0.05,
        tp_pct_delta: 0.005
      }
    }
  end

  defp injected_update("kis") do
    %{
      governance_tier: :allow,
      action: :adjust_domestic_threshold,
      reason: :domestic_persistence_smoke,
      proposals: %{
        stock_starter_approve_domestic_delta: 50_000
      }
    }
  end

  defp injected_update(_exchange) do
    %{
      governance_tier: :allow,
      action: :adjust_overseas_threshold,
      reason: :overseas_persistence_smoke,
      proposals: %{
        min_confidence_delta: -0.02
      }
    }
  end

  defp persisted_row?(%{status: :ok, completed: true, persisted_count: count}) when count > 0, do: true
  defp persisted_row?(_row), do: false
end
