defmodule Darwin.V2.Rag.QualityEvaluator do
  @moduledoc """
  Agentic RAG — 검색 결과 품질 평가 (Phase A).

  각 문서에 relevance/freshness/source_weight 점수 부여.
  평균 quality 계산 → @quality_threshold 미만이면 AgenticRag이 web_search fallback 트리거.
  """

  @quality_threshold 0.6
  # 소스별 기본 가중치
  @source_weights %{
    "l2_memory"      => 0.9,
    "cycle_history"  => 0.7,
    "community"      => 0.6,
    "web"            => 0.5
  }

  @doc """
  문서 목록에 품질 점수 부여.
  반환: {:ok, %{docs: [map()], quality: float()}}
  """
  @spec score([map()], String.t()) :: {:ok, map()}
  def score(docs, _query) when is_list(docs) do
    if Enum.empty?(docs) do
      {:ok, %{docs: [], quality: 0.0}}
    else
      scored_docs = Enum.map(docs, &score_doc/1)
      avg_quality = average_quality(scored_docs)
      {:ok, %{docs: scored_docs, quality: avg_quality}}
    end
  end

  @doc "재검색 후 원본 + 웹 결과 병합 + 재평가."
  @spec merge_and_rescore(map(), [map()], String.t()) :: map()
  def merge_and_rescore(%{docs: existing_docs} = _scored, web_docs, query) do
    all_docs = existing_docs ++ Enum.map(web_docs, &score_doc/1)
    {:ok, merged} = score(all_docs, query)
    merged
  end

  @doc "품질이 임계값 이하인지 확인."
  @spec below_threshold?(float()) :: boolean()
  def below_threshold?(quality), do: quality < @quality_threshold

  defp score_doc(doc) do
    source    = Map.get(doc, "source", "unknown")
    freshness = freshness_score(doc)
    weight    = Map.get(@source_weights, source, 0.5)
    quality   = (freshness + weight) / 2.0

    Map.put(doc, "_quality", Float.round(quality, 3))
  end

  defp freshness_score(doc) do
    case Map.get(doc, "inserted_at") do
      nil -> 0.5
      ts when is_binary(ts) ->
        case DateTime.from_iso8601(ts) do
          {:ok, dt, _} -> compute_freshness(dt)
          _ -> 0.5
        end
      %DateTime{} = dt -> compute_freshness(dt)
      _ -> 0.5
    end
  end

  defp compute_freshness(dt) do
    days_old = DateTime.diff(DateTime.utc_now(), dt, :day)
    cond do
      days_old <= 7   -> 1.0
      days_old <= 30  -> 0.8
      days_old <= 90  -> 0.6
      days_old <= 180 -> 0.4
      true            -> 0.2
    end
  end

  defp average_quality([]), do: 0.0
  defp average_quality(docs) do
    total = Enum.sum(Enum.map(docs, &Map.get(&1, "_quality", 0.5)))
    Float.round(total / length(docs), 3)
  end
end
