defmodule Luna.V2.Rag.QueryPlanner do
  @moduledoc """
  Agentic RAG — 쿼리 분해 (Query Decomposition).

  복잡한 쿼리를 2~3개 서브쿼리로 분할.
  Primary: Hub LLM(haiku) 호출
  Fallback: 규칙 기반 (LLM 실패 시)
  """
  require Logger

  @doc """
  query를 서브쿼리 리스트로 분해.

  반환: [query, sub1, sub2, ...]
  """
  def decompose(query, context \\ %{}) do
    case llm_decompose(query, context) do
      {:ok, subqueries} when length(subqueries) > 1 ->
        subqueries

      _ ->
        Logger.debug("[QueryPlanner] LLM fallback → 규칙 기반 분해")
        rule_based_decompose(query, context)
    end
  end

  # ─── Internal ─────────────────────────────────────────────────────

  defp llm_decompose(query, _context) do
    hub_url   = System.get_env("HUB_BASE_URL", "http://localhost:7788")
    hub_token = System.get_env("HUB_AUTH_TOKEN", "")

    prompt = """
    다음 투자 쿼리를 pgvector 검색에 최적화된 2~3개의 독립적인 서브쿼리로 분해하세요.
    각 서브쿼리는 한 줄씩 JSON 배열로 반환하세요.

    원본 쿼리: #{query}

    반드시 JSON 배열 형식으로만 답하세요:
    ["서브쿼리1", "서브쿼리2", "서브쿼리3"]
    """

    case Req.post("#{hub_url}/hub/llm/call",
           json: %{
             prompt: prompt,
             abstractModel: "anthropic_haiku",
             agent: "luna.rag_query_planner",
             callerTeam: "luna",
             urgency: "low",
             taskType: "query_decomposition"
           },
           headers: [{"Authorization", "Bearer #{hub_token}"}],
           receive_timeout: 15_000) do
      {:ok, %Req.Response{status: 200, body: %{"result" => text}}} when is_binary(text) ->
        parse_subqueries(text)

      _ ->
        {:error, :llm_unavailable}
    end
  rescue
    _ -> {:error, :llm_failed}
  end

  defp parse_subqueries(text) do
    case Regex.run(~r/\[.*\]/s, text) do
      [json_str] ->
        case Jason.decode(json_str) do
          {:ok, list} when is_list(list) and length(list) >= 2 ->
            {:ok, Enum.filter(list, &is_binary/1)}
          _ ->
            {:error, :parse_failed}
        end
      _ ->
        {:error, :no_json}
    end
  end

  defp rule_based_decompose(query, context) do
    category = context[:category]
    symbol   = context[:symbol]

    subqueries = [query]

    subqueries = if category do
      subqueries ++ ["#{query} #{category} 사례"]
    else
      subqueries ++ ["#{query} 실패 사례", "#{query} 유사 패턴"]
    end

    subqueries = if symbol do
      subqueries ++ ["#{symbol} 과거 유사 조건"]
    else
      subqueries
    end

    Enum.uniq(subqueries)
  end
end
