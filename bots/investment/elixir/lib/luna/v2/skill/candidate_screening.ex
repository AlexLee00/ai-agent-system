defmodule Luna.V2.Skill.CandidateScreening do
  @moduledoc """
  제약형 후보 선정 — 분석가 결과를 토대로 순위화.

  자유 생성형 결정 금지: 허용된 심볼 집합 안에서 점수 기반 선정.
  """
  use Jido.Action,
    name:        "candidate_screening",
    description: "분석가 신호 기반 매매 후보 제약형 선정",
    schema: [
      research: [type: :map,  required: true],
      market:   [type: :atom, required: true]
    ]

  require Logger

  @max_candidates 3

  @impl true
  def run(%{research: research, market: market}, _context) do
    Logger.info("[CandidateScreening] 후보 선정 — market=#{market}")

    universe = get_approved_universe(market)

    candidates =
      universe
      |> Enum.map(fn symbol -> score_symbol(symbol, research, market) end)
      |> Enum.filter(fn c -> c.score >= 0.6 end)
      |> Enum.sort_by(& &1.score, :desc)
      |> Enum.take(@max_candidates)

    Logger.info("[CandidateScreening] 후보 #{length(candidates)}개 선정")
    {:ok, %{candidates: candidates, market: market}}
  end

  defp get_approved_universe(:crypto),   do: ~w[BTCUSDT ETHUSDT SOLUSDT BNBUSDT XRPUSDT]
  defp get_approved_universe(:domestic), do: ~w[005930 000660 035420 035720 051910]
  defp get_approved_universe(:overseas), do: ~w[AAPL MSFT NVDA TSLA AMZN]
  defp get_approved_universe(_),         do: []

  defp score_symbol(symbol, research, market) do
    # 각 분석가 신호를 가중치로 집계
    weights = %{argos: 0.2, aria: 0.25, hermes: 0.15, sophia: 0.15, oracle: 0.15, zeus: 0.05, athena: 0.05}

    score =
      Enum.reduce(weights, 0.0, fn {analyst, weight}, acc ->
        analyst_result = Map.get(research, analyst, %{})
        signal = Map.get(analyst_result, :signal, :neutral)
        confidence = Map.get(analyst_result, :confidence, 0.5)

        signal_score = case signal do
          :bullish  -> 1.0
          :strong_bullish -> 1.2
          :neutral  -> 0.5
          :bearish  -> 0.0
          :strong_bearish -> -0.2
          :skipped  -> 0.5
          _ -> 0.5
        end

        acc + signal_score * confidence * weight
      end)

    # 정규화 (0~1)
    normalized = min(1.0, max(0.0, score))

    %{
      symbol: symbol,
      market: market,
      score: normalized,
      direction: if(normalized >= 0.65, do: :long, else: :short),
      amount_krw: default_size(market),
      timestamp: DateTime.utc_now()
    }
  end

  defp default_size(:crypto),   do: 100_000
  defp default_size(:domestic), do: 200_000
  defp default_size(:overseas), do: 150_000
  defp default_size(_),         do: 100_000
end
