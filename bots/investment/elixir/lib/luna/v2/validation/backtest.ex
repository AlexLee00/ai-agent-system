defmodule Luna.V2.Validation.Backtest do
  @moduledoc """
  Validation Stage 1 — 6개월 trade_history 기반 백테스트.

  투자.trade_history 테이블에서 심볼별 통계 집계.
  Sharpe / hit_rate / max_dd 반환.
  """
  require Logger

  @lookback_months 6

  @doc """
  strategy 맵을 받아 백테스트 결과 반환.

  반환: {:ok, %{type: :backtest, trades, avg_pnl, sharpe, max_dd, hit_rate}}
  """
  def run(strategy) do
    symbols = get_in(strategy, [:parameter_snapshot, "symbols"]) || []
    Logger.debug("[Backtest] 심볼=#{inspect(symbols)} #{@lookback_months}개월")

    if symbols == [] do
      {:ok, empty_result()}
    else
      query_and_compute(symbols)
    end
  end

  # ─── Internal ─────────────────────────────────────────────────────

  defp query_and_compute(symbols) do
    query = """
    SELECT
      COUNT(*)                                                          AS trades,
      COALESCE(AVG(pnl_pct), 0)                                        AS avg_pnl,
      COALESCE(STDDEV(pnl_pct), 0)                                     AS stdev_pnl,
      COALESCE(MIN(pnl_pct), 0)                                        AS max_dd,
      COALESCE(
        COUNT(CASE WHEN pnl_pct > 0 THEN 1 END)::float / GREATEST(COUNT(*), 1),
        0
      )                                                                 AS hit_rate
    FROM investment.trade_history
    WHERE symbol = ANY($1)
      AND closed_at > NOW() - ($2 || ' months')::interval
    """
    case Jay.Core.Repo.query(query, [symbols, to_string(@lookback_months)]) do
      {:ok, %{rows: [[trades, avg_pnl, stdev, max_dd, hit_rate | _] | _]}} ->
        avg_f    = to_f(avg_pnl)
        stdev_f  = to_f(stdev)
        {:ok, %{
          type:      :backtest,
          trades:    to_i(trades),
          avg_pnl:   avg_f,
          sharpe:    calc_sharpe(avg_f, stdev_f),
          max_dd:    to_f(max_dd),
          hit_rate:  to_f(hit_rate)
        }}

      {:ok, %{rows: []}} ->
        {:ok, empty_result()}

      err ->
        Logger.warning("[Backtest] 쿼리 실패: #{inspect(err)}")
        {:ok, empty_result()}
    end
  rescue
    e ->
      Logger.error("[Backtest] 예외: #{inspect(e)}")
      {:ok, empty_result()}
  end

  defp empty_result do
    %{type: :backtest, trades: 0, avg_pnl: 0.0, sharpe: 0.0, max_dd: 0.0, hit_rate: 0.0}
  end

  @doc "Sharpe Ratio (연환산 252일 기준)."
  def calc_sharpe(avg_pnl, stdev) when stdev > 0.0001 do
    Float.round(avg_pnl / stdev * :math.sqrt(252), 4)
  end
  def calc_sharpe(avg_pnl, _stdev) when avg_pnl > 0, do: 99.0
  def calc_sharpe(_, _), do: 0.0

  defp to_f(nil), do: 0.0
  defp to_f(d) when is_struct(d, Decimal), do: Decimal.to_float(d)
  defp to_f(n) when is_number(n), do: n * 1.0
  defp to_f(_), do: 0.0

  defp to_i(nil), do: 0
  defp to_i(d) when is_struct(d, Decimal), do: Decimal.to_integer(d)
  defp to_i(n) when is_integer(n), do: n
  defp to_i(n) when is_float(n), do: round(n)
  defp to_i(_), do: 0
end
