defmodule Sigma.V2.Rag.MultiSourceRetriever do
  @moduledoc """
  Agentic RAG — L2 메모리 + Directive 이력 병렬 검색.

  소스:
  1. L2 pgvector (Sigma procedural + episodic 메모리)
  2. sigma_v2_directive_audit (과거 Directive 실행 이력)
  3. sigma_dpo_preference_pairs (preferred 사례)
  """

  require Logger

  @top_k 5
  @audit_limit 10

  @doc """
  sub-query 목록으로 다중 소스 병렬 검색.
  반환: {:ok, [%{content, source, score, metadata}]}
  """
  @spec fetch([String.t()], map()) :: {:ok, [map()]}
  def fetch(subqueries, context \\ %{}) when is_list(subqueries) do
    team = Map.get(context, :team)

    tasks = [
      Task.async(fn -> fetch_l2_memory(subqueries) end),
      Task.async(fn -> fetch_directive_history(subqueries, team) end),
      Task.async(fn -> fetch_dpo_preferred(subqueries) end)
    ]

    results =
      tasks
      |> Task.yield_many(10_000)
      |> Enum.flat_map(fn
        {_task, {:ok, {:ok, docs}}} -> docs
        _ -> []
      end)

    {:ok, results}
  rescue
    e ->
      Logger.warning("[Sigma.V2.Rag.MultiSourceRetriever] fetch 실패: #{inspect(e)}")
      {:ok, []}
  end

  @doc "웹 검색 fallback — L2 품질 부족 시 sigma_v2_audit 최신 항목."
  @spec web_search(String.t()) :: [map()]
  def web_search(query) when is_binary(query) do
    sql = """
    SELECT directive_id::text AS id, team, outcome, action
    FROM sigma_v2_directive_audit
    WHERE outcome = 'success'
    ORDER BY executed_at DESC
    LIMIT 5
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: rows, columns: cols}} ->
        atom_cols = Enum.map(cols, &String.to_atom/1)

        Enum.map(rows, fn row ->
          record = Enum.zip(atom_cols, row) |> Map.new()
          %{
            content: "최근 성공 Directive [#{record[:team]}]: #{inspect(record[:action])}",
            source: :audit_fallback,
            score: 0.4,
            metadata: %{team: record[:team], outcome: record[:outcome]}
          }
        end)

      _ ->
        []
    end
  rescue
    _ -> []
  end

  # ─────────────────────────────────────────────────
  # Private — 소스별 검색
  # ─────────────────────────────────────────────────

  defp fetch_l2_memory(subqueries) do
    combined_query = Enum.join(subqueries, " ")

    case Sigma.V2.Memory.recall(combined_query, limit: @top_k, threshold: 0.3) do
      {:ok, %{hits: hits}} ->
        docs =
          Enum.map(hits, fn hit ->
            %{
              content: hit[:content] || "",
              source: :l2_memory,
              score: hit[:similarity] || 0.5,
              metadata: hit[:metadata] || %{}
            }
          end)

        {:ok, docs}

      _ ->
        {:ok, []}
    end
  rescue
    _ -> {:ok, []}
  end

  defp fetch_directive_history(subqueries, team) do
    keyword = subqueries |> List.first() |> safe_keyword()
    team_filter = if team, do: "AND team = '#{team}'", else: ""

    sql = """
    SELECT directive_id::text AS id, team, outcome, action, executed_at
    FROM sigma_v2_directive_audit
    WHERE outcome IN ('success', 'failure')
      #{team_filter}
    ORDER BY executed_at DESC
    LIMIT #{@audit_limit}
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: rows, columns: cols}} ->
        atom_cols = Enum.map(cols, &String.to_atom/1)

        docs =
          rows
          |> Enum.map(fn row -> Enum.zip(atom_cols, row) |> Map.new() end)
          |> Enum.filter(fn r -> directive_matches?(r, keyword) end)
          |> Enum.map(fn r ->
            score = if r[:outcome] == "success", do: 0.7, else: 0.3
            %{
              content: "#{r[:outcome]} Directive [#{r[:team]}]: #{inspect(r[:action])}",
              source: :directive_history,
              score: score,
              metadata: Map.take(r, [:team, :outcome, :executed_at])
            }
          end)

        {:ok, docs}

      _ ->
        {:ok, []}
    end
  rescue
    _ -> {:ok, []}
  end

  defp fetch_dpo_preferred(subqueries) do
    _keyword = subqueries |> List.first() |> safe_keyword()

    sql = """
    SELECT cycle_id, analyst, team, critique, score
    FROM sigma_dpo_preference_pairs
    WHERE category = 'preferred'
    ORDER BY score DESC, inserted_at DESC
    LIMIT 5
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: rows, columns: cols}} ->
        atom_cols = Enum.map(cols, &String.to_atom/1)

        docs =
          Enum.map(rows, fn row ->
            r = Enum.zip(atom_cols, row) |> Map.new()
            %{
              content: "preferred Directive [#{r[:team]}, #{r[:analyst]}]: #{r[:critique]}",
              source: :dpo_preferred,
              score: to_float(r[:score]) * 0.9,
              metadata: %{analyst: r[:analyst], team: r[:team]}
            }
          end)

        {:ok, docs}

      _ ->
        {:ok, []}
    end
  rescue
    _ -> {:ok, []}
  end

  defp directive_matches?(_record, nil), do: true
  defp directive_matches?(record, keyword) do
    content = inspect(record[:action]) || ""
    String.contains?(String.downcase(content), String.downcase(keyword))
  end

  defp safe_keyword(nil), do: nil
  defp safe_keyword(s) when is_binary(s) do
    s |> String.split(~r/\s+/) |> List.first()
  end

  defp to_float(v) when is_float(v), do: v
  defp to_float(v) when is_integer(v), do: v * 1.0
  defp to_float(_), do: 0.5
end
