defmodule Sigma.V2.ShadowCompare do
  @moduledoc """
  v1 vs v2 결과 비교 — 일치율 계산 + 일일 리포트.
  Shadow 7일 운영 중 매일 호출하여 95%+ 일치율 추적.
  """

  require Logger

  @target_match_rate 0.95

  @doc "오늘의 v1 vs v2 비교 리포트 생성."
  @spec daily_report(Date.t()) :: {:ok, map()} | {:error, term()}
  def daily_report(date \\ Date.utc_today()) do
    shadow_runs = fetch_shadow_runs(date)
    v1_runs = fetch_v1_runs(date)

    if shadow_runs == [] do
      Logger.warning("[sigma_v2][compare] #{date} Shadow 실행 기록 없음")
      {:ok, %{date: date, v1_matches_v2: nil, reason: "no_shadow_data"}}
    else
      details = Enum.map(shadow_runs, fn shadow ->
        v1 = Enum.find(v1_runs, fn r -> r[:id] == shadow[:v1_daily_run_id] end)
        compare_one(shadow, v1)
      end)

      match_scores = details |> Enum.map(& &1[:match_score]) |> Enum.reject(&is_nil/1)
      overall = if match_scores == [], do: nil, else: Float.round(Enum.sum(match_scores) / length(match_scores), 4)

      passed = is_number(overall) and overall >= @target_match_rate

      result = %{
        date: date,
        v1_matches_v2: overall,
        target: @target_match_rate,
        passed: passed,
        shadow_run_count: length(shadow_runs),
        details: details
      }

      if passed do
        Logger.info("[sigma_v2][compare] #{date} 일치율 #{overall} ✅ 목표 달성")
      else
        Logger.warning("[sigma_v2][compare] #{date} 일치율 #{overall} ⚠ 목표 미달 (목표: #{@target_match_rate})")
      end

      {:ok, result}
    end
  end

  @doc "7일간 집계 리포트."
  @spec weekly_report() :: {:ok, map()}
  def weekly_report do
    days = for i <- 0..6, do: Date.add(Date.utc_today(), -i)

    results =
      Enum.map(days, fn date ->
        case daily_report(date) do
          {:ok, report} -> {date, report[:v1_matches_v2]}
          _ -> {date, nil}
        end
      end)

    valid = Enum.reject(results, fn {_, v} -> is_nil(v) end)
    avg = if valid == [], do: nil, else: Float.round(Enum.sum(Enum.map(valid, &elem(&1, 1))) / length(valid), 4)

    {:ok, %{
      period: "7d",
      days: results |> Enum.map(fn {d, v} -> %{date: d, match: v} end),
      average_match: avg,
      passed: is_number(avg) and avg >= @target_match_rate
    }}
  end

  # -------------------------------------------------------------------
  # Private
  # -------------------------------------------------------------------

  defp compare_one(shadow, nil) do
    %{shadow_id: shadow[:id], v1_id: nil, match_score: shadow[:match_score], status: "no_v1_pair"}
  end

  defp compare_one(shadow, v1) do
    v2_teams = get_teams_from_shadow(shadow)
    v1_teams = get_teams_from_v1(v1)

    intersection = MapSet.intersection(v2_teams, v1_teams) |> MapSet.size()
    union = MapSet.union(v2_teams, v1_teams) |> MapSet.size()

    team_match = if union == 0, do: 1.0, else: Float.round(intersection / union, 4)

    %{
      shadow_id: shadow[:id],
      v1_id: v1[:id],
      match_score: team_match,
      target_teams_v2: MapSet.to_list(v2_teams),
      target_teams_v1: MapSet.to_list(v1_teams),
      status: if(team_match >= @target_match_rate, do: "pass", else: "below_target")
    }
  end

  defp get_teams_from_shadow(shadow) do
    formation = shadow[:formation] || %{}
    teams = formation[:target_teams] || formation["target_teams"] || []
    MapSet.new(teams)
  end

  defp get_teams_from_v1(v1) do
    formation = v1[:formation] || %{}
    teams = formation[:targetTeams] || formation["targetTeams"] || []
    MapSet.new(teams)
  end

  defp fetch_shadow_runs(date) do
    sql = """
    SELECT id, run_date, formation, v1_daily_run_id, match_score
    FROM sigma_v2_shadow_runs
    WHERE run_date = $1
    ORDER BY id ASC
    """

    case TeamJay.Repo.query(sql, [date]) do
      {:ok, %{rows: rows, columns: cols}} ->
        atom_cols = Enum.map(cols, &String.to_atom/1)
        Enum.map(rows, &(Enum.zip(atom_cols, &1) |> Map.new()))

      _ ->
        []
    end
  rescue
    _ -> []
  end

  defp fetch_v1_runs(date) do
    sql = """
    SELECT id, run_date, formation
    FROM sigma.daily_runs
    WHERE run_date = $1
    ORDER BY id ASC
    """

    case TeamJay.Repo.query(sql, [date]) do
      {:ok, %{rows: rows, columns: cols}} ->
        atom_cols = Enum.map(cols, &String.to_atom/1)
        Enum.map(rows, &(Enum.zip(atom_cols, &1) |> Map.new()))

      _ ->
        []
    end
  rescue
    _ -> []
  end
end
