defmodule Sigma.V2.Rag.QueryPlanner do
  @moduledoc """
  Agentic RAG — Sigma Directive 쿼리를 sub-query로 분해.

  시그마 고유: Directive 효과 예측, 팀 관찰 맥락, 유사 과거 사례 검색에 특화.
  LLM 분해 실패 시 규칙 기반 fallback (무해 실패).
  """

  require Logger

  @max_subqueries 4

  @doc """
  쿼리를 2~4개의 sub-query로 분해.
  반환: {:ok, [String.t()]}
  """
  @spec decompose(String.t(), map()) :: {:ok, [String.t()]}
  def decompose(query, context \\ %{}) when is_binary(query) do
    case llm_decompose(query, context) do
      {:ok, subs} when is_list(subs) and length(subs) > 0 -> {:ok, subs}
      _ -> {:ok, rule_decompose(query)}
    end
  end

  defp llm_decompose(query, context) do
    team = Map.get(context, :team, "unknown")
    feedback_type = Map.get(context, :feedback_type, "general")

    prompt = """
    시그마 메타 코치로서, 다음 팀 관찰 쿼리를 #{@max_subqueries}개 이하의 sub-query로 분해하세요.
    각 sub-query는 독립적으로 메모리에서 검색 가능해야 합니다.

    원본 쿼리: #{query}
    대상 팀: #{team}
    피드백 유형: #{feedback_type}

    반드시 JSON 배열로만 답하세요: ["sub1", "sub2", ...]
    설명 없이 JSON만 출력.
    """

    case Sigma.V2.LLM.Selector.call_with_fallback(:reflexion, prompt, max_tokens: 300) do
      {:ok, %{response: content}} when is_binary(content) -> parse_subqueries(content)
      _ -> {:error, :llm_unavailable}
    end
  end

  defp parse_subqueries(content) when is_binary(content) do
    case Regex.run(~r/\[.*?\]/s, content) do
      [json_str] ->
        case Jason.decode(json_str) do
          {:ok, list} when is_list(list) ->
            subs =
              list
              |> Enum.filter(&is_binary/1)
              |> Enum.take(@max_subqueries)

            if length(subs) > 0, do: {:ok, subs}, else: {:error, :empty}

          _ ->
            {:error, :parse_failed}
        end

      _ ->
        {:error, :no_json}
    end
  end

  defp rule_decompose(query) do
    words = String.split(query, ~r/\s+/, trim: true)

    if length(words) > 6 do
      mid = div(length(words), 2)
      {first, second} = Enum.split(words, mid)
      [Enum.join(first, " "), Enum.join(second, " ")]
    else
      [query]
    end
  end
end
