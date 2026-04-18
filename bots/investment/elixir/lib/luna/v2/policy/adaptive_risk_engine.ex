defmodule Luna.V2.Policy.AdaptiveRiskEngine do
  @moduledoc """
  L21 적응형 리스크 엔진 — 시장 regime별 포지션 사이즈 동적 조정.

  regime: calm / normal / volatile / extreme
  각 regime별 포지션 크기 배율 적용.
  """
  require Logger

  @regime_multipliers %{
    calm:     1.2,
    normal:   1.0,
    volatile: 0.6,
    extreme:  0.3
  }

  def adjust(candidate, market_context \\ %{}) do
    regime = detect_regime(market_context)
    multiplier = Map.get(@regime_multipliers, regime, 1.0)

    adjusted_krw = round((candidate[:amount_krw] || 0) * multiplier)

    adjusted = candidate
    |> Map.put(:amount_krw, adjusted_krw)
    |> Map.put(:amount_usd, round((candidate[:amount_usd] || 0) * multiplier))
    |> Map.put(:adjusted_by, :adaptive_risk)
    |> Map.put(:regime, regime)
    |> Map.put(:size_multiplier, multiplier)

    Logger.debug("[AdaptiveRisk] regime=#{regime} multiplier=#{multiplier} symbol=#{candidate[:symbol]}")
    {:ok, adjusted}
  end

  def detect_regime(context) do
    vix = Map.get(context, :vix, 20.0)
    vol = Map.get(context, :volatility_1d, 0.03)
    fng = Map.get(context, :fear_and_greed, 50)

    cond do
      vix > 40 or vol > 0.08 or fng < 15 -> :extreme
      vix > 25 or vol > 0.05 or fng < 25 -> :volatile
      vix < 15 and vol < 0.02 and fng > 65 -> :calm
      true -> :normal
    end
  end
end
