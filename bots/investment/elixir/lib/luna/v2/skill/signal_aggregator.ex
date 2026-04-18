defmodule Luna.V2.Skill.SignalAggregator do
  @moduledoc "멀티 에이전트 신호 통합 — 최근 N개 신호의 가중 평균 점수 계산"
  use Jido.Action,
    name: "signal_aggregator",
    description: "최근 투자 신호들의 가중 평균 점수를 계산합니다.",
    schema: [
      symbol: [type: :string, required: true, doc: "심볼 (예: BTC/USDT, 005930)"],
      hours:  [type: :integer, required: false, default: 6, doc: "최근 N시간 신호 범위"]
    ]

  require Logger

  # 에이전트별 가중치 (루나 판단 최고, 기술/뉴스 중간, 감성 낮음)
  @weights %{
    "luna"    => 3.0,
    "nemesis" => 2.0,
    "aria"    => 1.5,
    "hermes"  => 1.2,
    "sophia"  => 1.0,
    "oracle"  => 1.3,
    "argos"   => 1.4,
    "zeus"    => 0.8,
    "athena"  => 0.8,
  }

  # 신호 → 숫자 점수
  @signal_scores %{
    "STRONG_BUY"  =>  2.0,
    "BUY"         =>  1.0,
    "HOLD"        =>  0.0,
    "SELL"        => -1.0,
    "STRONG_SELL" => -2.0,
  }

  def run(%{symbol: symbol, hours: hours}, _context) do
    Logger.info("[루나V2/SignalAggregator] #{symbol} 신호 집계 (최근 #{hours}h)")

    query = """
    SELECT agent_name, signal, confidence
    FROM investment.trade_signals
    WHERE symbol = $1
      AND created_at >= NOW() - INTERVAL '#{hours} hours'
      AND signal IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 50
    """

    case Jay.Core.Repo.query(query, [symbol]) do
      {:ok, %{rows: []}} ->
        {:ok, %{symbol: symbol, score: 0.0, signal_count: 0, recommendation: "HOLD", agents: []}}

      {:ok, %{rows: rows}} ->
        {weighted_sum, weight_sum, agents} =
          Enum.reduce(rows, {0.0, 0.0, []}, fn [agent, signal, confidence], {ws, wt, ag} ->
            weight     = Map.get(@weights, agent, 1.0)
            sig_score  = Map.get(@signal_scores, signal, 0.0)
            conf       = if is_nil(confidence), do: 0.5, else: confidence
            contribution = weight * sig_score * conf
            {ws + contribution, wt + weight, [{agent, signal, conf} | ag]}
          end)

        score = if weight_sum > 0, do: Float.round(weighted_sum / weight_sum, 3), else: 0.0
        recommendation = cond do
          score >=  1.0 -> "STRONG_BUY"
          score >=  0.3 -> "BUY"
          score <= -1.0 -> "STRONG_SELL"
          score <= -0.3 -> "SELL"
          true          -> "HOLD"
        end

        {:ok, %{
          symbol:         symbol,
          score:          score,
          signal_count:   length(rows),
          recommendation: recommendation,
          agents:         Enum.reverse(agents),
          aggregated_at:  DateTime.utc_now()
        }}

      {:error, reason} ->
        {:ok, %{symbol: symbol, score: 0.0, recommendation: "HOLD", error: inspect(reason)}}
    end
  end
end
