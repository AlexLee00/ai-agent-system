defmodule Luna.V2.Skill.MarketRegimeDetector do
  @moduledoc "시장 레짐 감지 — crypto/domestic/overseas 각 마켓 상태 분류"
  use Jido.Action,
    name: "market_regime_detector",
    description: "현재 시장 레짐을 trending_bull/trending_bear/ranging/volatile 중 하나로 분류합니다.",
    schema: [
      market: [type: :string, required: false, default: "crypto",
               doc: "분석 마켓 (crypto/domestic/overseas)"]
    ]

  require Logger

  @valid_regimes ~w[trending_bull trending_bear ranging volatile unknown]

  def run(%{market: market}, _context) do
    Logger.info("[루나V2/MarketRegimeDetector] #{market} 레짐 감지 중")
    case fetch_regime(market) do
      {:ok, regime} ->
        {:ok, %{market: market, regime: regime, updated_at: DateTime.utc_now()}}
      {:error, reason} ->
        {:ok, %{market: market, regime: "unknown", error: reason, updated_at: DateTime.utc_now()}}
    end
  end

  defp fetch_regime(market) do
    query = """
    SELECT regime
    FROM investment.market_regime_snapshots
    WHERE market = $1
    ORDER BY captured_at DESC
    LIMIT 1
    """
    case Jay.Core.Repo.query(query, [market]) do
      {:ok, %{rows: [[regime | _] | _]}} when regime in @valid_regimes ->
        {:ok, regime}
      {:ok, %{rows: []}} ->
        {:ok, "unknown"}
      {:error, reason} ->
        {:error, inspect(reason)}
    end
  end
end
