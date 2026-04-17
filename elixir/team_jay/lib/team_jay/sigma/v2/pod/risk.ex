defmodule Sigma.V2.Pod.Risk do
  @moduledoc """
  Risk Pod — hawk(위험 감시 분석가) + optimizer(효율 최적화 분석가).
  리스크 관점 분석 담당 Pod.
  """

  use Jido.AI.Agent,
    name: "sigma_v2_pod_risk",
    model: :fast,
    tools: [
      Sigma.V2.Skill.DataQualityGuard,
      Sigma.V2.Skill.CausalCheck
    ],
    system_prompt: "리스크 관점 분석 Pod. hawk(위험 감시) + optimizer(효율)."

  @doc """
  팀 메트릭을 리스크 관점에서 분석한다.
  두 분석가(hawk/optimizer)가 병렬로 평가 후 합의 recommendation 반환.
  """
  @spec analyze(map(), map()) :: {:ok, map()} | {:error, term()}
  def analyze(state, metric) when is_map(metric) do
    hawk_view = hawk_analysis(metric)
    optimizer_view = optimizer_analysis(metric)

    consensus = consensus_score([hawk_view, optimizer_view])

    {:ok,
     %{
       pod: "risk",
       analysts: ["hawk", "optimizer"],
       hawk: hawk_view,
       optimizer: optimizer_view,
       recommendation: consensus,
       state: state
     }}
  end

  # hawk — 위험 패턴 감지
  defp hawk_analysis(metric) do
    issues = []

    issues =
      if (metric[:low_score_agents] || 0) > 3, do: issues ++ ["저성과 에이전트 다수 감지"], else: issues

    issues =
      if (metric[:error_rate] || 0) > 0.05, do: issues ++ ["에러율 임계 초과"], else: issues

    issues =
      if (metric[:live_positions] || 0) > 10, do: issues ++ ["과다 오픈 포지션 리스크"], else: issues

    %{analyst: "hawk", perspective: "risk_review", issues: issues, severity: severity(length(issues))}
  end

  # optimizer — 비용/효율성 분석
  defp optimizer_analysis(metric) do
    suggestions = []

    suggestions =
      if (metric[:avg_score] || 10.0) < 6.0,
        do: suggestions ++ ["에이전트 평균 점수 낮음 — 설정 재검토 권장"],
        else: suggestions

    suggestions =
      if (metric[:published_7d] || 0) < 3 and metric[:metric_type] == "content_ops",
        do: suggestions ++ ["주간 발행량 저조 — 파이프라인 점검"],
        else: suggestions

    %{analyst: "optimizer", perspective: "workflow_tuning", suggestions: suggestions, efficiency: efficiency(metric)}
  end

  defp severity(0), do: "low"
  defp severity(1), do: "medium"
  defp severity(_), do: "high"

  defp efficiency(metric) do
    score = metric[:avg_score] || 5.0
    Float.round(score / 10.0, 2)
  end

  defp consensus_score(views) do
    all_issues = Enum.flat_map(views, fn v -> v[:issues] || v[:suggestions] || [] end)

    cond do
      length(all_issues) >= 3 ->
        "리스크 다수 감지 — 즉각적인 팀 점검 필요. 주요 문제: #{Enum.join(Enum.take(all_issues, 2), ", ")}"
      length(all_issues) >= 1 ->
        "리스크 일부 감지 — 모니터링 강화 권장. #{hd(all_issues)}"
      true ->
        "정상 운영 중 — 현재 리스크 낮음"
    end
  end
end
