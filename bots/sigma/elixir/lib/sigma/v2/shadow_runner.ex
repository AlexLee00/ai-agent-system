defmodule Sigma.V2.ShadowRunner do
  @moduledoc """
  Shadow Mode — TS runDaily() 실행 후 v2 Commander도 동일 입력으로 실행,
  결과를 sigma_v2_shadow_runs 테이블에 기록. 비교 가능.

  v2가 대상 팀에 Signal을 발송하지 않음 (record_shadow_run 기록 전용).
  Shadow 7일 운영 후 95%+ 일치율 확인되면 Phase 2 착수.
  """

  require Logger

  @doc "Shadow 실행: v2 편성 결정 + 분석 → DB 기록."
  @spec run(map()) :: {:ok, map()} | {:error, term()}
  def run(opts \\ %{}) do
    date = Map.get(opts, :date, Date.utc_today())
    memories = Map.get(opts, :memories, [])
    recent_semantic = Map.get(opts, :recent_semantic, [])
    v1_run_id = Map.get(opts, :v1_daily_run_id)

    Logger.info("[sigma_v2][shadow] Shadow Mode 실행 시작 date=#{date}")

    with {:ok, formation} <- Sigma.V2.Commander.decide_formation(date, memories, recent_semantic),
         {:ok, analysis} <- Sigma.V2.Commander.analyze_formation(formation, memories) do
      match_score = compute_match_score(formation, v1_run_id)

      result = %{
        date: date,
        formation: formation,
        analysis: analysis,
        v1_daily_run_id: v1_run_id,
        match_score: match_score
      }

      case record_shadow_run(result) do
        {:ok, id} ->
          Logger.info("[sigma_v2][shadow] 기록 완료 id=#{id} match_score=#{match_score}")
          {:ok, Map.put(result, :shadow_run_id, id)}

        {:error, reason} ->
          Logger.error("[sigma_v2][shadow] 기록 실패: #{inspect(reason)}")
          {:error, reason}
      end
    else
      {:error, reason} ->
        Logger.error("[sigma_v2][shadow] 실행 실패: #{inspect(reason)}")
        {:error, reason}
    end
  end

  @doc "문서/스크립트 하위호환용 별칭."
  @spec run_once(map()) :: {:ok, map()} | {:error, term()}
  def run_once(opts \\ %{}), do: run(opts)

  # -------------------------------------------------------------------
  # Private
  # -------------------------------------------------------------------

  defp record_shadow_run(%{date: date, formation: formation, analysis: analysis, v1_daily_run_id: v1_id, match_score: score}) do
    sql = """
    INSERT INTO sigma_v2_shadow_runs (run_date, formation, analysis, v1_daily_run_id, match_score, inserted_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
    RETURNING id
    """

    case Jay.Core.Repo.query(sql, [
           date,
           Jason.encode!(formation),
           Jason.encode!(analysis),
           v1_id,
           score
         ]) do
      {:ok, %{rows: [[id]]}} -> {:ok, id}
      {:ok, _} -> {:ok, nil}
      {:error, reason} -> {:error, reason}
    end
  rescue
    e -> {:error, Exception.message(e)}
  end

  defp compute_match_score(_formation, nil), do: nil

  defp compute_match_score(formation, v1_run_id) do
    v1_run = fetch_v1_run(v1_run_id)

    if is_nil(v1_run) do
      nil
    else
      v2_teams = MapSet.new(formation[:target_teams] || [])
      v1_teams = v1_run |> get_in(["formation", "targetTeams"]) |> then(fn
        t when is_list(t) -> MapSet.new(t)
        _ -> MapSet.new()
      end)

      intersection = MapSet.intersection(v2_teams, v1_teams) |> MapSet.size()
      union = MapSet.union(v2_teams, v1_teams) |> MapSet.size()

      if union == 0, do: 1.0, else: Float.round(intersection / union, 4)
    end
  end

  defp fetch_v1_run(id) do
    sql = "SELECT formation FROM sigma.daily_runs WHERE id = $1 LIMIT 1"

    case Jay.Core.Repo.query(sql, [id]) do
      {:ok, %{rows: [[formation]]}} -> formation
      _ -> nil
    end
  rescue
    _ -> nil
  end
end
