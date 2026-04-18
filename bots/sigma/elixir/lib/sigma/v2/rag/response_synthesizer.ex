defmodule Sigma.V2.Rag.ResponseSynthesizer do
  @moduledoc """
  Agentic RAG — 다중 소스 검색 결과를 통합 응답으로 합성.

  상위 문서들을 컨텍스트로 LLM이 시그마 코칭 관점의 통합 응답 생성.
  문서가 없거나 LLM 실패 시 최상위 문서 내용을 직접 반환.
  """

  require Logger

  @max_context_docs 5

  @doc """
  검색 결과를 통합하여 최종 응답 생성.
  반환: {:ok, %{answer: String.t(), sources: [map()], quality: float()}}
  """
  @spec combine(map(), String.t()) :: {:ok, map()}
  def combine(%{docs: docs, quality: quality}, query) when is_list(docs) do
    top_docs = Enum.take(docs, @max_context_docs)

    if top_docs == [] do
      {:ok, %{answer: "", sources: [], quality: quality}}
    else
      answer =
        case llm_synthesize(top_docs, query) do
          {:ok, text} when is_binary(text) and text != "" -> text
          _ -> fallback_answer(top_docs)
        end

      sources = Enum.map(top_docs, &Map.take(&1, [:source, :score, :metadata]))

      {:ok, %{answer: answer, sources: sources, quality: quality}}
    end
  rescue
    e ->
      Logger.warning("[Sigma.V2.Rag.ResponseSynthesizer] combine 실패: #{inspect(e)}")
      {:ok, %{answer: "", sources: [], quality: 0.0}}
  end

  defp llm_synthesize(docs, query) do
    context =
      docs
      |> Enum.with_index(1)
      |> Enum.map_join("\n\n", fn {doc, i} ->
        "[#{i}] (#{doc[:source]}, score=#{doc[:score]})\n#{doc[:content]}"
      end)

    prompt = """
    시그마 메타 코치로서 다음 정보를 바탕으로 쿼리에 답하세요.

    [쿼리]
    #{query}

    [참조 문서]
    #{context}

    3~5문장으로 핵심만 답하세요. 과거 패턴과 실패 교훈을 중심으로.
    """

    case Sigma.V2.LLM.Selector.call_with_fallback(:reflexion, prompt, max_tokens: 400) do
      {:ok, %{response: text}} -> {:ok, text}
      _ -> {:error, :llm_unavailable}
    end
  end

  defp fallback_answer(docs) do
    docs
    |> Enum.take(3)
    |> Enum.map_join("\n", &Map.get(&1, :content, ""))
  end
end
