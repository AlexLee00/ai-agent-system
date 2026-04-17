defmodule Sigma.V2.Pod.Trend do
  @moduledoc """
  Trend Pod — owl(장기 트렌드 분석가) + forecaster(예측 분석가).
  추세·예측 관점 분석 담당 Pod.
  """

  use Jido.AI.Agent,
    name: "sigma_v2_pod_trend",
    model: :fast,
    tools: [
      Sigma.V2.Skill.FeaturePlanner,
      Sigma.V2.Skill.ObservabilityPlanner
    ],
    system_prompt: "추세 관점 분석 Pod. owl(장기 트렌드) + forecaster(예측)."

  @doc """
  팀 메트릭을 추세 관점에서 분석한다.
  두 분석가(owl/forecaster)가 병렬로 평가 후 합의 recommendation 반환.
  """
  @spec analyze(map(), map()) :: {:ok, map()} | {:error, term()}
  def analyze(state, metric) when is_map(metric) do
    owl_view = owl_analysis(metric)
    forecaster_view = forecaster_analysis(metric)

    {:ok,
     %{
       pod: "trend",
       analysts: ["owl", "forecaster"],
       owl: owl_view,
       forecaster: forecaster_view,
       recommendation: trend_consensus(owl_view, forecaster_view),
       state: state
     }}
  end

  # owl — 장기 트렌드 패턴 감지
  defp owl_analysis(metric) do
    trend_signals = []

    trend_signals =
      if (metric[:trades_7d] || 0) > (metric[:avg_7d_baseline] || 5),
        do: trend_signals ++ ["거래 증가 추세 감지"],
        else: trend_signals

    trend_signals =
      if (metric[:published_7d] || 0) >= 7,
        do: trend_signals ++ ["콘텐츠 발행 일관성 확인"],
        else: trend_signals

    trend_signals =
      if (metric[:duration_sec] || 0) > 200,
        do: trend_signals ++ ["리서치 소요시간 증가 추세"],
        else: trend_signals

    %{
      analyst: "owl",
      perspective: "trend_watch",
      trend_signals: trend_signals,
      structural_change: length(trend_signals) >= 2
    }
  end

  # forecaster — 단기 예측
  defp forecaster_analysis(metric) do
    predictions = []

    live_pos = metric[:live_positions] || 0

    predictions =
      if live_pos > 5,
        do: predictions ++ ["활성 포지션 #{live_pos}건 — 24h 내 변동성 주시"],
        else: predictions

    predictions =
      if (metric[:low_score_agents] || 0) > 2,
        do: predictions ++ ["저성과 에이전트 누적 — 향후 품질 저하 리스크"],
        else: predictions

    %{
      analyst: "forecaster",
      perspective: "forecast_adjust",
      predictions: predictions,
      risk_horizon: if(length(predictions) > 0, do: "24h", else: "stable")
    }
  end

  defp trend_consensus(owl, forecaster) do
    signals = (owl[:trend_signals] || []) ++ (forecaster[:predictions] || [])

    cond do
      owl[:structural_change] ->
        "구조적 변화 감지 — 주간 추세 재평가 권장. #{Enum.join(Enum.take(signals, 2), " / ")}"
      signals != [] ->
        "추세 변화 신호 — 모니터링 강화. #{hd(signals)}"
      true ->
        "안정적 추세 유지 — 현행 방향 유지"
    end
  end
end
