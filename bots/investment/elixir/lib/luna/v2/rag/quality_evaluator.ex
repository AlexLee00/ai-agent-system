defmodule Luna.V2.Rag.QualityEvaluator do
  @moduledoc """
  Agentic RAG — 검색 품질 평가.

  검색된 문서의 품질을 0.0~1.0 점수로 평가.

  평가 기준:
  1. 문서 수 (0~@max_docs 기준, 40% 가중치)
  2. 평균 similarity (30% 가중치)
  3. 카테고리 다양성 (30% 가중치)

  임계값: @quality_threshold = 0.7 미만이면 재시도 권장.
  """

  @quality_threshold 0.7
  @max_docs          10
  @all_categories    ~w[trade_review news_memo thesis failure_case regime_shift analyst_insight]

  @doc "검색된 문서들의 품질 점수 반환 (0.0~1.0)."
  def score(docs, _original_query \\ "") when is_list(docs) do
    count_score    = count_score(length(docs))
    sim_score      = similarity_score(docs)
    diversity_score = category_diversity_score(docs)

    total = Float.round(count_score * 0.4 + sim_score * 0.3 + diversity_score * 0.3, 4)
    min(1.0, max(0.0, total))
  end

  @doc "임계값 이상인지 확인."
  def sufficient?(docs, query \\ "") do
    score(docs, query) >= @quality_threshold
  end

  @doc "임계값 반환."
  def threshold, do: @quality_threshold

  # ─── Internal ─────────────────────────────────────────────────────

  defp count_score(0), do: 0.0
  defp count_score(n), do: min(1.0, n / @max_docs)

  defp similarity_score([]), do: 0.0
  defp similarity_score(docs) do
    sims = Enum.map(docs, fn d ->
      to_f(d["similarity"] || d[:similarity] || 0.0)
    end)
    Enum.sum(sims) / length(sims)
  end

  defp category_diversity_score([]), do: 0.0
  defp category_diversity_score(docs) do
    categories =
      docs
      |> Enum.map(fn d -> d["category"] || d[:category] end)
      |> Enum.filter(&is_binary/1)
      |> Enum.uniq()

    found = Enum.count(categories, fn c -> c in @all_categories end)
    min(1.0, found / max(3, length(@all_categories)))
  end

  defp to_f(n) when is_number(n), do: n * 1.0
  defp to_f(d) when is_struct(d, Decimal), do: Decimal.to_float(d)
  defp to_f(_), do: 0.0
end
