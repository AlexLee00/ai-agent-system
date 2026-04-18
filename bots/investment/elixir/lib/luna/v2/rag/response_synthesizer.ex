defmodule Luna.V2.Rag.ResponseSynthesizer do
  @moduledoc """
  Agentic RAG — 응답 합성.

  검색된 문서들을 카테고리별로 그룹화하고 중복을 제거하여
  최종 컨텍스트 리스트를 반환.

  최대 @max_output개 유지, similarity 내림차순 정렬.
  """

  @max_output 5

  @doc """
  문서 리스트를 합성하여 컨텍스트 리스트 반환.

  반환: [%{content, category, similarity, symbol, market}, ...]
  """
  def combine(docs, _query \\ "") when is_list(docs) do
    docs
    |> Enum.filter(fn d -> content(d) != nil end)
    |> group_by_category()
    |> flatten_with_limit(@max_output)
    |> Enum.map(&normalize_doc/1)
  end

  # ─── Internal ─────────────────────────────────────────────────────

  defp group_by_category(docs) do
    docs
    |> Enum.group_by(fn d -> d["category"] || d[:category] || "unknown" end)
    |> Enum.map(fn {cat, cat_docs} ->
      # 카테고리 내에서 similarity 내림차순 상위 2개만
      top = Enum.sort_by(cat_docs, fn d ->
        -(to_f(d["similarity"] || d[:similarity] || 0.0))
      end) |> Enum.take(2)
      {cat, top}
    end)
    |> Enum.sort_by(fn {_cat, docs} ->
      # 카테고리 최고 similarity 기준 정렬
      max_sim = Enum.map(docs, &to_f(&1["similarity"] || &1[:similarity] || 0.0)) |> Enum.max(fn -> 0.0 end)
      -max_sim
    end)
  end

  defp flatten_with_limit(grouped, limit) do
    grouped
    |> Enum.flat_map(fn {_cat, docs} -> docs end)
    |> Enum.take(limit)
  end

  defp normalize_doc(doc) do
    %{
      content:    content(doc),
      category:   doc["category"]   || doc[:category],
      similarity: to_f(doc["similarity"] || doc[:similarity] || 0.0),
      symbol:     doc["symbol"]     || doc[:symbol],
      market:     doc["market"]     || doc[:market]
    }
  end

  defp content(doc), do: doc["content"] || doc[:content]

  defp to_f(n) when is_number(n), do: n * 1.0
  defp to_f(d) when is_struct(d, Decimal), do: Decimal.to_float(d)
  defp to_f(_), do: 0.0
end
