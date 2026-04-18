defmodule TeamJay.Ska.Rag.QualityEvaluator do
  @moduledoc """
  검색 결과 품질 평가 + 재검색 필요 판단.

  입력: docs = [%{source: ..., content: ..., score: float}, ...]
  출력: {:ok, scored_docs}

  평가 기준:
  - 소스 다양성 (1개 소스만이면 점수 하락)
  - 시간 최신성 (오래된 이력은 가중치 감소)
  - 내용 관련성 (실패 컨텍스트와 키워드 매칭)
  - 최소 품질 임계값 (@quality_threshold = 0.7)
  """

  @quality_threshold 0.7

  @doc "문서 목록에 품질 점수 부여"
  def score(docs, failure_context) when is_list(docs) do
    if docs == [] do
      {:ok, []}
    else
      scored =
        docs
        |> Enum.map(fn doc -> score_document(doc, failure_context) end)
        |> Enum.sort_by(& &1.final_score, :desc)

      {:ok, scored}
    end
  end

  @doc "평균 품질이 임계값 이상인지"
  def meets_threshold?(scored_docs) do
    if scored_docs == [] do
      false
    else
      avg = Enum.sum(Enum.map(scored_docs, & &1.final_score)) / length(scored_docs)
      avg >= @quality_threshold
    end
  end

  @doc "재검색 필요 여부"
  def needs_retry?(scored_docs) do
    not meets_threshold?(scored_docs)
  end

  @doc "품질 임계값"
  def quality_threshold, do: @quality_threshold

  # ─── 내부 ────────────────────────────────────────────────

  defp score_document(doc, failure_context) do
    base_score = doc[:score] || 0.5

    # 소스 신뢰도 보정
    source_bonus = source_trust_bonus(doc[:source])

    # 키워드 관련성 보정
    relevance = relevance_score(doc[:content] || "", failure_context)

    final = Float.round(base_score * 0.5 + source_bonus * 0.3 + relevance * 0.2, 3)

    Map.merge(doc, %{
      final_score: min(final, 1.0),
      source_bonus: source_bonus,
      relevance: relevance
    })
  end

  defp source_trust_bonus(:failure_library), do: 0.9
  defp source_trust_bonus(:past_recovery), do: 0.85
  defp source_trust_bonus(:selector_history), do: 0.8
  defp source_trust_bonus(:operations_rag), do: 0.75
  defp source_trust_bonus(:cross_team), do: 0.5
  defp source_trust_bonus(:broader_history), do: 0.4
  defp source_trust_bonus(_), do: 0.5

  defp relevance_score(content, failure_context) do
    agent = to_string(failure_context[:agent] || "")
    error = to_string(failure_context[:error] || "")
    message = to_string(failure_context[:message] || "")

    keywords = [agent, error] ++ String.split(message, " ", parts: 5)

    matches =
      Enum.count(keywords, fn kw ->
        kw != "" and String.contains?(String.downcase(content), String.downcase(kw))
      end)

    min(matches / max(length(keywords), 1), 1.0)
  end
end
