defmodule TeamJay.Ska.Rag.MultiSourceRetriever do
  @moduledoc """
  스카팀 전용 다중 소스 문서 검색.

  소스:
  1. FailureLibrary L1/L2/L3 (기존 3계층 RAG)
  2. SelectorManager (과거 작동한 셀렉터 버전)
  3. Cross-Team event_lake (루나/다윈/블로 유사 복구 이력)
  4. OperationsRag (운영 지식 베이스)
  5. Past Recovery Success (스카 과거 복구 성공 이력)
  """
  require Logger

  @doc """
  서브쿼리 목록으로 모든 소스를 병렬 검색.
  """
  def fetch(subqueries) do
    results =
      Task.async_stream(subqueries, &fetch_for_subquery/1,
        max_concurrency: 5,
        timeout: 15_000,
        on_timeout: :kill_task
      )
      |> Enum.flat_map(fn
        {:ok, docs} -> docs
        {:exit, _reason} -> []
      end)

    Logger.debug("[MultiSourceRetriever] #{length(results)}개 문서 검색 완료")
    {:ok, results}
  end

  @doc "재검색 — 더 넓은 범위로 (QualityEvaluator 점수 미달 시)"
  def fetch_broader(failure_context) do
    agent = failure_context[:agent] || :unknown

    # 시간 범위 확대 (30일)
    docs = fetch_broader_failure_history(agent, 30)
    {:ok, docs}
  end

  # ─── 소스별 검색 ─────────────────────────────────────────

  defp fetch_for_subquery(subquery) do
    [
      fetch_failure_library(subquery),
      fetch_selector_history(subquery),
      fetch_cross_team_incidents(subquery),
      fetch_operations_rag(subquery),
      fetch_past_recoveries(subquery)
    ]
    |> Enum.concat()
  end

  defp fetch_failure_library(subquery) do
    try do
      # Hub memory API 경유 (기존 FailureLibrary 유지)
      case query_hub_memory("ska", subquery[:value], limit: 5) do
        {:ok, docs} ->
          Enum.map(docs, fn d -> Map.put(d, :source, :failure_library) end)
        _ -> []
      end
    rescue
      _ -> []
    end
  end

  defp fetch_selector_history(subquery) do
    if subquery[:type] == :error_class and
       subquery[:value] == :selector_parse_failure do
      try do
        case TeamJay.Ska.SelectorManager.get_version_history(:andy) do
          {:ok, history} ->
            Enum.map(history, fn v ->
              %{
                source: :selector_history,
                content: "셀렉터 버전 #{v[:version]} — 성공률 #{v[:success_rate]}%",
                score: 0.6,
                metadata: v
              }
            end)
          _ -> []
        end
      rescue
        _ -> []
      end
    else
      []
    end
  end

  defp fetch_cross_team_incidents(subquery) do
    try do
      sql = """
      SELECT team, event_type, payload, inserted_at
      FROM agent_event_lake
      WHERE event_type LIKE '%failure%'
        AND inserted_at > NOW() - INTERVAL '14 days'
        AND team != 'ska'
      ORDER BY inserted_at DESC
      LIMIT 3
      """
      case Jay.Core.Repo.query(sql, []) do
        {:ok, %{rows: rows, columns: cols}} ->
          Enum.map(rows, fn row ->
            data = Enum.zip(cols, row) |> Map.new()
            %{source: :cross_team, content: inspect(data), score: 0.4, metadata: data}
          end)
        _ -> []
      end
    rescue
      _ -> []
    end
  end

  defp fetch_operations_rag(subquery) do
    try do
      case TeamJay.Ska.Analytics.OperationsRag.search(inspect(subquery[:value]), limit: 3) do
        {:ok, docs} ->
          Enum.map(docs, fn d -> Map.put(d, :source, :operations_rag) end)
        _ -> []
      end
    rescue
      _ -> []
    end
  end

  defp fetch_past_recoveries(subquery) do
    try do
      sql = """
      SELECT skill_name, category, critique, improvement_hint, score, inserted_at
      FROM ska_skill_preference_pairs
      WHERE category = 'preferred'
        AND inserted_at > NOW() - INTERVAL '30 days'
      ORDER BY score DESC
      LIMIT 5
      """
      case Jay.Core.Repo.query(sql, []) do
        {:ok, %{rows: rows, columns: cols}} ->
          Enum.map(rows, fn row ->
            data = Enum.zip(cols, row) |> Map.new()
            %{
              source: :past_recovery,
              content: "스킬 #{data["skill_name"]} 성공 사례 (점수 #{data["score"]}): #{data["critique"]}",
              score: data["score"] || 0.5,
              metadata: data
            }
          end)
        _ -> []
      end
    rescue
      _ -> []
    end
  end

  defp fetch_broader_failure_history(agent, days) do
    try do
      sql = """
      SELECT id, skill_name, status, error_reason, duration_ms, inserted_at
      FROM ska_skill_execution_log
      WHERE caller_agent = $1
        AND status = 'failure'
        AND inserted_at > NOW() - ($2 || ' days')::interval
      ORDER BY inserted_at DESC
      LIMIT 20
      """
      case Jay.Core.Repo.query(sql, [to_string(agent), days]) do
        {:ok, %{rows: rows, columns: cols}} ->
          Enum.map(rows, fn row ->
            data = Enum.zip(cols, row) |> Map.new()
            %{source: :broader_history, content: inspect(data), score: 0.3, metadata: data}
          end)
        _ -> []
      end
    rescue
      _ -> []
    end
  end

  defp query_hub_memory(team, query, opts) do
    limit = Keyword.get(opts, :limit, 5)
    params = %{team: team, query: inspect(query), limit: limit}

    case Jay.Core.HubClient.post("/hub/memory/search", params) do
      {:ok, %{"results" => results}} ->
        {:ok, Enum.map(results, fn r ->
          %{source: :hub_memory, content: r["content"] || "", score: r["score"] || 0.5}
        end)}
      _ ->
        {:error, :hub_unavailable}
    end
  end
end
