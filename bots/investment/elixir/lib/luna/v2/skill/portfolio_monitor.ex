defmodule Luna.V2.Skill.PortfolioMonitor do
  @moduledoc "포지션 현황 + 손익 요약 조회 (investment 스키마)"
  use Jido.Action,
    name: "portfolio_monitor",
    description: "현재 활성 포지션 목록과 오늘의 손익을 요약합니다.",
    schema: [
      market: [type: :string, required: false, default: "all",
               doc: "필터 마켓 (crypto/domestic/overseas/all)"]
    ]

  require Logger

  def run(%{market: market}, _context) do
    Logger.info("[루나V2/PortfolioMonitor] 포지션 조회 market=#{market}")
    with {:ok, positions} <- fetch_positions(market),
         {:ok, pnl}       <- fetch_daily_pnl(market) do
      reflexive = build_reflexive_summary(positions)
      {:ok, %{
        positions:     positions,
        daily_pnl:     pnl,
        reflexive:     reflexive,
        position_count: length(positions),
        queried_at:    DateTime.utc_now()
      }}
    else
      {:error, reason} -> {:ok, %{error: reason, positions: [], daily_pnl: %{}}}
    end
  end

  defp fetch_positions("all") do
    query = """
    SELECT exchange, symbol, side, size, entry_price, unrealized_pnl
    FROM investment.live_positions
    WHERE status = 'open'
    ORDER BY exchange, symbol
    LIMIT 50
    """
    case Jay.Core.Repo.query(query, []) do
      {:ok, %{rows: rows, columns: cols}} ->
        {:ok, Enum.map(rows, &Enum.zip(cols, &1) |> Map.new())}
      {:error, r} -> {:error, inspect(r)}
    end
  end

  defp fetch_positions(market) do
    exchange_filter = case market do
      "crypto"   -> "'binance','upbit'"
      "domestic" -> "'kis'"
      "overseas" -> "'kis_overseas'"
      _          -> "'binance','upbit','kis','kis_overseas'"
    end
    query = """
    SELECT exchange, symbol, side, size, entry_price, unrealized_pnl
    FROM investment.live_positions
    WHERE status = 'open' AND exchange IN (#{exchange_filter})
    ORDER BY exchange, symbol
    LIMIT 50
    """
    case Jay.Core.Repo.query(query, []) do
      {:ok, %{rows: rows, columns: cols}} ->
        {:ok, Enum.map(rows, &Enum.zip(cols, &1) |> Map.new())}
      {:error, r} -> {:error, inspect(r)}
    end
  end

  defp fetch_daily_pnl(_market) do
    query = """
    SELECT
      COALESCE(SUM(realized_pnl_usd), 0) AS realized_usd,
      COALESCE(SUM(unrealized_pnl_usd), 0) AS unrealized_usd
    FROM investment.live_positions
    WHERE DATE(created_at AT TIME ZONE 'Asia/Seoul') = CURRENT_DATE
    """
    case Jay.Core.Repo.query(query, []) do
      {:ok, %{rows: [[r, u] | _]}} ->
        {:ok, %{realized_usd: r, unrealized_usd: u, total_usd: Decimal.add(r || 0, u || 0)}}
      _ ->
        {:ok, %{realized_usd: 0, unrealized_usd: 0, total_usd: 0}}
    end
  end

  defp build_reflexive_summary(positions) when is_list(positions) do
    totals =
      Enum.reduce(positions, %{notional: Decimal.new("0"), drawdown_chain: 0, top_symbol: %{}, max_corr: 0.0}, fn pos, acc ->
        size = to_decimal(Map.get(pos, "size"))
        entry = to_decimal(Map.get(pos, "entry_price"))
        unreal = to_decimal(Map.get(pos, "unrealized_pnl"))
        notional = Decimal.mult(size, entry)
        pnl_ratio =
          if Decimal.compare(notional, Decimal.new("0")) == :gt do
            Decimal.div(unreal, notional) |> Decimal.to_float()
          else
            0.0
          end

        symbol = to_string(Map.get(pos, "symbol") || "")
        top_symbol =
          if symbol == "" do
            acc.top_symbol
          else
            Map.update(acc.top_symbol, symbol, notional, &Decimal.add(&1, notional))
          end

        %{
          notional: Decimal.add(acc.notional, notional),
          drawdown_chain: if(pnl_ratio <= -0.02, do: acc.drawdown_chain + 1, else: acc.drawdown_chain),
          top_symbol: top_symbol,
          max_corr: acc.max_corr
        }
      end)

    total_notional = Decimal.to_float(totals.notional)
    {top_symbol, top_notional} =
      totals.top_symbol
      |> Enum.sort_by(fn {_k, v} -> Decimal.to_float(v) end, :desc)
      |> List.first()
      |> case do
        nil -> {nil, Decimal.new("0")}
        {k, v} -> {k, v}
      end

    concentration =
      if total_notional > 0 do
        Decimal.div(top_notional, totals.notional) |> Decimal.to_float()
      else
        0.0
      end

    reason_codes =
      []
      |> maybe_append(concentration >= 0.45, "concentration_over_limit")
      |> maybe_append(totals.drawdown_chain >= 3, "drawdown_chain_detected")

    %{
      protective: reason_codes != [],
      reason_codes: reason_codes,
      total_notional: total_notional,
      top_symbol: top_symbol,
      concentration: concentration,
      drawdown_chain: totals.drawdown_chain,
      emergency_event: if(reason_codes == [], do: nil, else: "portfolio_reflexive_alert")
    }
  end

  defp build_reflexive_summary(_), do: %{}

  defp maybe_append(list, true, value), do: [value | list]
  defp maybe_append(list, false, _value), do: list

  defp to_decimal(nil), do: Decimal.new("0")
  defp to_decimal(%Decimal{} = value), do: value
  defp to_decimal(value) when is_number(value), do: Decimal.from_float(value * 1.0)
  defp to_decimal(value) when is_binary(value) do
    case Decimal.parse(value) do
      {parsed, _} -> parsed
      :error -> Decimal.new("0")
    end
  end
  defp to_decimal(_), do: Decimal.new("0")
end
