defmodule Darwin.V2.Rag.QueryPlanner do
  @moduledoc """
  Agentic RAG — 복잡한 연구 쿼리를 sub-query로 분해 (Phase A).

  LLM 기반 분해 → 실패 시 규칙 기반 fallback.
  kill switch OFF 또는 LLM 실패 시 원본 쿼리 단일 리스트 반환.
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
    prompt = """
    다음 연구 쿼리를 최대 #{@max_subqueries}개의 sub-query로 분해하세요.
    각 sub-query는 독립적으로 검색 가능한 구체적 질문이어야 합니다.

    원본 쿼리: #{query}
    맥락: #{inspect(context, limit: 200)}

    반드시 JSON 배열로만 답하세요: ["sub1", "sub2", ...]
    설명 없이 JSON만 출력.
    """

    try do
      case Darwin.V2.LLM.Selector.complete(
             "darwin.rag.query_planner",
             [%{role: "user", content: prompt}],
             max_tokens: 300,
             urgency: :low
           ) do
        {:ok, content} -> parse_subqueries(content)
        {:error, _reason} -> {:error, :llm_unavailable}
      end
    rescue
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

          _ -> {:error, :parse_failed}
        end

      _ -> {:error, :no_json}
    end
  end

  defp rule_decompose(query) do
    # 키워드 기반 단순 분해 — LLM 실패 시 최소 fallback
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
