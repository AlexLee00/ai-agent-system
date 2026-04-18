defmodule Darwin.V2.Rag.ResponseSynthesizer do
  @moduledoc """
  Agentic RAG — 최종 응답 통합 생성 (Phase A).

  다중 소스에서 검색된 문서들을 LLM으로 통합 → 최종 answer 생성.
  LLM 실패 시 상위 문서를 단순 concat한 요약 반환.
  """

  require Logger

  @max_context_chars 3_000
  @max_docs_in_context 5

  @doc """
  검색 결과 + 원본 쿼리 → 통합 응답 생성.
  반환: {:ok, %{answer: String.t(), sources: [map()], quality: float()}}
  """
  @spec combine(map(), String.t()) :: {:ok, map()}
  def combine(%{docs: docs, quality: quality}, query) do
    if Enum.empty?(docs) do
      {:ok, %{answer: "관련 문서를 찾지 못했습니다.", sources: [], quality: 0.0}}
    else
      top_docs = Enum.take(docs, @max_docs_in_context)
      context  = build_context(top_docs)

      answer =
        case synthesize_via_llm(query, context) do
          {:ok, text} -> text
          _           -> fallback_summary(top_docs)
        end

      {:ok, %{answer: answer, sources: top_docs, quality: quality}}
    end
  end

  defp synthesize_via_llm(query, context) do
    prompt = """
    다음 컨텍스트를 바탕으로 연구 질문에 답하세요.
    컨텍스트에 없는 내용은 추측하지 마세요.

    [질문]
    #{query}

    [검색된 컨텍스트]
    #{context}

    간결하게 핵심만 답하세요 (한국어, 200자 이내).
    """

    Darwin.V2.LLM.Selector.complete(
      "darwin.rag.synthesizer",
      [%{role: "user", content: prompt}],
      max_tokens: 300,
      urgency: :low
    )
  end

  defp build_context(docs) do
    docs
    |> Enum.map(fn doc ->
      content = Map.get(doc, "content") || Map.get(doc, "paper_title") || ""
      String.slice(content, 0, div(@max_context_chars, @max_docs_in_context))
    end)
    |> Enum.join("\n---\n")
    |> String.slice(0, @max_context_chars)
  end

  defp fallback_summary(docs) do
    docs
    |> Enum.map(fn doc ->
      Map.get(doc, "content") || Map.get(doc, "paper_title") || ""
    end)
    |> Enum.reject(&(&1 == ""))
    |> Enum.take(3)
    |> Enum.join(" | ")
    |> String.slice(0, 500)
  end
end
