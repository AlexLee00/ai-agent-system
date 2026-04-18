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
      {:ok, %{
        positions:     positions,
        daily_pnl:     pnl,
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
end
