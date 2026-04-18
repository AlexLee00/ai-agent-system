defmodule Darwin.V2.Rag.MultiSourceRetriever do
  @moduledoc """
  Agentic RAG — 다중 소스 병렬 검색 (Phase A).

  검색 소스:
  1. L2 Memory (pgvector, darwin_agent_memory)
  2. Past Cycles (darwin_cycle_history)
  3. Community cache (darwin_v2_shadow_runs — 스캐너 캐시로 활용)

  각 소스는 독립 Task로 병렬 실행, 30초 타임아웃.
  실패한 소스는 무시하고 나머지 결과 합산.
  """

  require Logger

  @task_timeout_ms 30_000

  @doc "여러 sub-query를 다중 소스에서 병렬 검색."
  @spec fetch([String.t()], map()) :: {:ok, [map()]}
  def fetch(subqueries, context \\ %{}) when is_list(subqueries) do
    tasks =
      Enum.map(subqueries, fn q ->
        Task.async(fn -> fetch_single(q, context) end)
      end)

    results =
      tasks
      |> Enum.map(&Task.yield(&1, @task_timeout_ms))
      |> Enum.map(fn
        {:ok, docs} -> docs
        nil         -> []
        _           -> []
      end)
      |> List.flatten()

    {:ok, results}
  end

  @doc "Web 검색 (phase A에서는 플레이스홀더 — Phase O에서 확장)."
  @spec web_search(String.t()) :: [map()]
  def web_search(_query) do
    # Phase O에서 실제 웹 검색 구현
    []
  end

  defp fetch_single(query, context) do
    [
      fetch_l2_memory(query, context),
      fetch_past_cycles(query)
    ]
    |> List.flatten()
  end

  defp fetch_l2_memory(query, _context) do
    sql = """
    SELECT content, memory_type, importance, tags, inserted_at
    FROM darwin_agent_memory
    WHERE team = 'darwin'
      AND inserted_at > NOW() - INTERVAL '90 days'
      AND (content ILIKE $1 OR tags::text ILIKE $1)
    ORDER BY importance DESC
    LIMIT 5
    """

    pattern = "%#{String.slice(query, 0, 50)}%"

    case Jay.Core.Repo.query(sql, [pattern]) do
      {:ok, %{rows: rows, columns: cols}} ->
        rows_to_docs(rows, cols, "l2_memory")

      _ -> []
    end
  rescue
    _ -> []
  end

  defp fetch_past_cycles(query) do
    sql = """
    SELECT cycle_id, paper_title, stage, inserted_at
    FROM darwin_cycle_history
    WHERE paper_title ILIKE $1
    ORDER BY inserted_at DESC
    LIMIT 3
    """

    pattern = "%#{String.slice(query, 0, 50)}%"

    case Jay.Core.Repo.query(sql, [pattern]) do
      {:ok, %{rows: rows, columns: cols}} ->
        rows_to_docs(rows, cols, "cycle_history")

      _ -> []
    end
  rescue
    _ -> []
  end

  defp rows_to_docs(rows, columns, source) do
    Enum.map(rows, fn row ->
      data = Enum.zip(columns, row) |> Map.new()
      Map.put(data, "source", source)
    end)
  end
end
