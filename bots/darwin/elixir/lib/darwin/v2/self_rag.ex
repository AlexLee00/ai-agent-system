defmodule Darwin.V2.SelfRAG do
  @moduledoc """
  Self-RAG 패턴 (arXiv 2310.11511) — 다윈 연구 특화.

  [Retrieve] → [Relevant] → [Supporting] → [Useful] 4-gate 회수 검증.
  논문 관련성, 실패 교훈, 구현 전략 등 연구 메모리를 검증하며 회수.

  Kill switch: Darwin.V2.Config.self_rag_enabled?()
    (기본 false — 명시적 활성화 필요)
  비활성 시: 기본 L2 recall로 폴백.

  Gate LLM: Darwin.V2.LLM.Selector.call_with_fallback("darwin.self_rag", ...) 경유.
  """

  require Logger

  @doc """
  4-gate 검증 포함 메모리 회수.
  Kill switch off 시 기본 L2 retrieve로 폴백.

  query: 검색 쿼리
  context: 현재 작업 컨텍스트 (논문 제목, 단계 등)
  opts: [top_k: integer, threshold: float, team: String.t]
  """
  @spec recall_and_validate(String.t(), map(), keyword()) ::
          {:ok, [map()]} | {:no_passage}
  def recall_and_validate(query, context \\ %{}, opts \\ []) do
    if Darwin.V2.Config.self_rag_enabled?() do
      Logger.debug("[다윈V2 SelfRAG] 4-gate 검증 모드 활성")
      do_recall_with_gates(query, context, opts)
    else
      Logger.debug("[다윈V2 SelfRAG] Kill switch off — 기본 L2 recall 폴백")
      fallback_recall(query, opts)
    end
  end

  defp do_recall_with_gates(query, context, opts) do
    task_desc = context[:task] || context[:paper_title] || "현재 연구 작업"

    # Gate 1: [Retrieve]
    retrieve_prompt = """
    현재 작업: #{task_desc}
    쿼리: #{query}

    이 쿼리에 과거 연구 경험(실패 교훈, 구현 전략, 논문 인사이트)을 검색하면 도움이 됩니까?
    정확히 한 토큰으로만 답하세요: [Retrieve] 또는 [No-Retrieve]
    """

    should_retrieve =
      case Darwin.V2.LLM.Selector.call_with_fallback("darwin.self_rag", retrieve_prompt, max_tokens: 20) do
        {:ok, %{response: text}} when is_binary(text) ->
          String.contains?(text, "[Retrieve]")
        _ -> true
      end

    unless should_retrieve do
      Logger.debug("[다윈V2 SelfRAG] [Retrieve=No] — 검색 건너뜀")
      {:no_passage}
    else
      team = Keyword.get(opts, :team, "darwin")
      top_k = Keyword.get(opts, :top_k, 5)
      threshold = Keyword.get(opts, :threshold, 0.3)

      case Darwin.V2.Memory.L2.retrieve(query, team, top_k: top_k, threshold: threshold) do
        {:ok, %{hits: raw_hits}} ->
          relevant = Enum.filter(raw_hits, &gate_relevant?(&1, query, context))
          supporting = Enum.filter(relevant, &gate_supporting?/1)
          useful = Enum.filter(supporting, &gate_useful?/1)

          Logger.info("[다윈V2 SelfRAG] 4-gate 완료 — raw=#{length(raw_hits)} relevant=#{length(relevant)} supporting=#{length(supporting)} useful=#{length(useful)}")

          if useful == [], do: {:no_passage}, else: {:ok, useful}

        _ -> {:no_passage}
      end
    end
  end

  defp fallback_recall(query, opts) do
    team = Keyword.get(opts, :team, "darwin")
    top_k = Keyword.get(opts, :top_k, 5)
    threshold = Keyword.get(opts, :threshold, 0.3)

    case Darwin.V2.Memory.L2.retrieve(query, team, top_k: top_k, threshold: threshold) do
      {:ok, %{hits: []}} -> {:no_passage}
      {:ok, %{hits: hits}} -> {:ok, hits}
      {:error, _} -> {:no_passage}
    end
  end

  defp gate_relevant?(hit, query, context) do
    content = hit[:content] || hit["content"] || ""
    task_desc = context[:task] || context[:paper_title] || ""

    prompt = """
    현재 작업: #{task_desc}
    쿼리: #{query}
    검색된 메모리: #{String.slice(content, 0, 300)}

    이 메모리가 현재 연구 작업에 실제로 관련이 있습니까?
    정확히 한 토큰으로만 답하세요: [Relevant] 또는 [Irrelevant]
    """

    case Darwin.V2.LLM.Selector.call_with_fallback("darwin.self_rag", prompt, max_tokens: 20) do
      {:ok, %{response: text}} when is_binary(text) ->
        String.contains?(text, "[Relevant]")
      _ ->
        similarity = hit[:similarity] || hit["similarity"] || 0.0
        similarity >= 0.4
    end
  end

  defp gate_supporting?(hit) do
    similarity = hit[:similarity] || hit["similarity"] || 0.0
    similarity >= 0.3
  end

  defp gate_useful?(hit) do
    importance = hit[:importance] || hit["importance"] || 0.5
    similarity = hit[:similarity] || hit["similarity"] || 0.0
    importance >= 0.4 and similarity >= 0.35
  end

  @doc "쿼리에 대한 관련 논문/메모리 회수 + 4-gate 필터링."
  @spec retrieve_and_filter(String.t(), keyword()) :: {:ok, [map()]} | {:error, term()}
  def retrieve_and_filter(query, opts \\ []) do
    top_k = Keyword.get(opts, :top_k, 10)
    threshold = Keyword.get(opts, :threshold, 0.6)

    if Darwin.V2.Config.self_rag_enabled?() do
      with {:ok, %{hits: hits}} <- Darwin.V2.Memory.L2.retrieve(query, "darwin", top_k: top_k, threshold: threshold),
           filtered <- Enum.filter(hits, &relevant?(&1, query)),
           filtered <- Enum.filter(filtered, &supporting?(&1, query)) do
        {:ok, filtered}
      end
    else
      {:ok, []}
    end
  end

  @doc "논문이 주어진 목표와 관련 있는지 빠른 판정 (LLM)."
  @spec relevant?(map(), String.t()) :: boolean()
  def relevant?(document, query) do
    prompt = """
    다음 텍스트가 주어진 연구 목표와 관련이 있는가?
    관련 있으면 "YES", 아니면 "NO"만 답하시오.

    연구 목표: #{query}
    텍스트: #{String.slice(document[:content] || "", 0, 300)}
    """

    case Darwin.V2.LLM.Selector.call_with_fallback("self_rag.relevance", prompt,
           max_tokens: 5,
           task_type: :binary_classification
         ) do
      {:ok, %{response: "YES"}} -> true
      {:ok, %{response: r}} when is_binary(r) -> String.upcase(String.slice(r, 0, 3)) == "YES"
      _ -> false
    end
  rescue
    _ -> true
  end

  @doc "문서가 답변을 지지하는지 판정."
  @spec supporting?(map(), String.t()) :: boolean()
  def supporting?(document, _query) do
    importance = document[:importance] || 0.0
    similarity = document[:similarity] || 0.0
    importance > 0.4 or similarity > 0.75
  end
end
