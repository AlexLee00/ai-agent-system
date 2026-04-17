defmodule Sigma.V2.SelfRAG do
  @moduledoc """
  Self-RAG 패턴 (arXiv 2310.11511).
  [Retrieve]/[Relevant]/[Supporting]/[Useful] 4-gate 회수 검증.
  SIGMA_SELF_RAG_ENABLED=false 기본 (Kill Switch).
  참조: bots/sigma/docs/PLAN.md §6 Phase 3
  """

  require Logger

  @doc "4-gate 검증 포함 메모리 회수. Kill Switch off 시 기본 Memory.recall로 폴백."
  def retrieve_with_gate(query, opts \\ []) do
    if System.get_env("SIGMA_SELF_RAG_ENABLED") == "true" do
      do_retrieve(query, opts)
    else
      Sigma.V2.Memory.recall(query, opts)
    end
  end

  # ---

  defp do_retrieve(query, opts) do
    case prompt_retrieval_gate(query) do
      :no_retrieve ->
        {:ok, []}

      :retrieve ->
        limit = Keyword.get(opts, :limit, 10)
        type = Keyword.get(opts, :type, :episodic)

        case Sigma.V2.Memory.L2.run(%{
               operation: :retrieve,
               content: query,
               team: "sigma",
               top_k: limit
             }, %{}) do
          {:ok, %{hits: raw_hits}} ->
            relevant = Enum.filter(raw_hits, &relevant?(&1, query))
            supporting = Enum.filter(relevant, &supports?(&1, query))
            useful = Enum.filter(supporting, &useful_quality?/1)
            _ = type
            {:ok, useful}

          _ ->
            {:ok, []}
        end
    end
  end

  defp prompt_retrieval_gate(query) do
    prompt = """
    Query: #{query}

    Does this query benefit from retrieved context?
    Respond with exactly one token: [Retrieve] or [No-Retrieve].
    """

    case Sigma.V2.LLM.Selector.call_with_fallback(:"skill.data_quality", prompt, max_tokens: 20) do
      {:ok, %{response: text}} when is_binary(text) ->
        if String.contains?(text, "[Retrieve]"), do: :retrieve, else: :no_retrieve

      _ ->
        :no_retrieve
    end
  end

  defp relevant?(hit, query) do
    content = hit[:content] || hit["content"] || ""
    prompt = "Query: #{query}\nHit: #{String.slice(content, 0, 300)}\nRespond [Relevant] or [Irrelevant]."

    case Sigma.V2.LLM.Selector.call_with_fallback(:"skill.data_quality", prompt, max_tokens: 20) do
      {:ok, %{response: text}} when is_binary(text) ->
        String.contains?(text, "[Relevant]")

      _ ->
        false
    end
  end

  defp supports?(_hit, _query), do: true  # Phase 3 간이화

  defp useful_quality?(hit) do
    score = hit[:quality_score] || hit["quality_score"] || 0.5
    score >= 0.5
  end
end
