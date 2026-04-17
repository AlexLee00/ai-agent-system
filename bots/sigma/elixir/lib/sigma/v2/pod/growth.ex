defmodule Sigma.V2.Pod.Growth do
  @moduledoc """
  Growth Pod — dove(보수적 안정 분석가) + librarian(지식 관리 분석가).
  성장 관점 분석 담당 Pod.
  """

  use Jido.AI.Agent,
    name: "sigma_v2_pod_growth",
    model: :fast,
    tools: [
      Sigma.V2.Skill.DataQualityGuard,
      Sigma.V2.Skill.ExperimentDesign
    ],
    system_prompt: "성장 관점 분석 Pod. dove(안정 성장) + librarian(지식 축적)."

  @doc """
  팀 메트릭을 성장 관점에서 분석한다.
  두 분석가(dove/librarian)가 병렬로 평가 후 합의 recommendation 반환.
  """
  @spec analyze(map(), map()) :: {:ok, map()} | {:error, term()}
  def analyze(state, metric) when is_map(metric) do
    dove_view = dove_analysis(metric)
    librarian_view = librarian_analysis(metric)

    {:ok,
     %{
       pod: "growth",
       analysts: ["dove", "librarian"],
       dove: dove_view,
       librarian: librarian_view,
       recommendation: growth_consensus(dove_view, librarian_view),
       state: state
     }}
  end

  # dove — 보수적 안정 관점 분석
  defp dove_analysis(metric) do
    strengths = []
    opportunities = []

    strengths =
      if (metric[:published_7d] || 0) >= 5,
        do: strengths ++ ["주간 발행 목표 달성"],
        else: strengths

    strengths =
      if (metric[:avg_score] || 0.0) >= 7.0,
        do: strengths ++ ["에이전트 고성과 유지"],
        else: strengths

    opportunities =
      if (metric[:ready_count] || 0) >= 3,
        do: opportunities ++ ["발행 대기 콘텐츠 #{metric[:ready_count]}건 활용 가능"],
        else: opportunities

    %{
      analyst: "dove",
      perspective: "growth_expand",
      strengths: strengths,
      opportunities: opportunities,
      growth_potential: growth_score(strengths, opportunities)
    }
  end

  # librarian — 과거 패턴 기반 지식 추출
  defp librarian_analysis(metric) do
    patterns = []

    patterns =
      if (metric[:high_relevance] || 0) > 5,
        do: patterns ++ ["고적합 리서치 자료 #{metric[:high_relevance]}건 Standing Orders 승격 후보"],
        else: patterns

    patterns =
      if (metric[:trades_7d] || 0) >= 10,
        do: patterns ++ ["주간 거래 #{metric[:trades_7d]}건 — 전략 패턴 추출 가능"],
        else: patterns

    %{
      analyst: "librarian",
      perspective: "knowledge_capture",
      patterns: patterns,
      rag_candidates: length(patterns)
    }
  end

  defp growth_score(strengths, opportunities) do
    base = length(strengths) * 2 + length(opportunities)
    min(10, base * 2)
  end

  defp growth_consensus(dove, librarian) do
    all_positives = (dove[:strengths] || []) ++ (dove[:opportunities] || []) ++ (librarian[:patterns] || [])

    cond do
      length(all_positives) >= 3 ->
        "성장 기회 다수 — 강점 확대 + 지식 축적 권장. 우선순위: #{hd(all_positives)}"
      length(all_positives) >= 1 ->
        "완만한 성장세 — 안정적 운영 유지하며 #{hd(all_positives)}"
      true ->
        "성장 지표 부재 — 기반 지표부터 점검 필요"
    end
  end
end
