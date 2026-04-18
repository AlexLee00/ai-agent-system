defmodule Luna.V2.Validation.ValidationLive do
  @moduledoc """
  Validation Stage 4 — 소액 실계좌 결과 집계.

  LUNA_DOMESTIC_VALIDATION=true 구간(amount_krw ≤ 100,000) 실거래 기록 분석.
  최근 14일, 승률 ≥ 0.50 & Sharpe ≥ 0.3 이면 pass.
  """
  require Logger

  @max_amount_krw 100_000
  @lookback_days  14
  @min_trades     5
  @pass_win_rate  0.50
  @pass_sharpe    0.30

  @doc """
  strategy 맵을 받아 validation_live 결과 반환.

  반환: {:ok, %{type: :validation_live, trades, win_rate, sharpe, pass}}
  """
  def run(strategy) do
    symbols = get_in(strategy, [:parameter_snapshot, "symbols"]) || []
    market  = strategy[:market] || "domestic"
    Logger.debug("[ValidationLive] market=#{market} symbols=#{inspect(symbols)}")

    query = """
    SELECT
      COUNT(*)                                                          AS trades,
      COALESCE(AVG(pnl_pct), 0)                                        AS avg_pnl,
      COALESCE(STDDEV(pnl_pct), 0)                                     AS stdev_pnl,
      COALESCE(
        COUNT(CASE WHEN pnl_pct > 0 THEN 1 END)::float / GREATEST(COUNT(*), 1),
        0
      )                                                                 AS win_rate
    FROM investment.trade_history
    WHERE market = $1
      AND amount_krw <= $2
      AND closed_at > NOW() - ($3 || ' days')::interval
      AND ($4::text[] = '{}' OR symbol = ANY($4))
    """
    syms = if symbols == [], do: [], else: symbols
    case Jay.Core.Repo.query(query, [to_string(market), @max_amount_krw, to_string(@lookback_days), syms]) do
      {:ok, %{rows: [[trades, avg_pnl, stdev, win_rate | _] | _]}} ->
        trades_i = to_i(trades)
        avg_f    = to_f(avg_pnl)
        stdev_f  = to_f(stdev)
        sharpe   = Luna.V2.Validation.Backtest.calc_sharpe(avg_f, stdev_f)
        win_f    = to_f(win_rate)
        {:ok, %{
          type:     :validation_live,
          trades:   trades_i,
          win_rate: win_f,
          sharpe:   sharpe,
          pass:     trades_i >= @min_trades and win_f >= @pass_win_rate and sharpe >= @pass_sharpe
        }}

      _ ->
        {:ok, %{type: :validation_live, trades: 0, win_rate: 0.0, sharpe: 0.0, pass: false}}
    end
  rescue
    e ->
      Logger.error("[ValidationLive] 예외: #{inspect(e)}")
      {:ok, %{type: :validation_live, trades: 0, win_rate: 0.0, sharpe: 0.0, pass: false}}
  end

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
