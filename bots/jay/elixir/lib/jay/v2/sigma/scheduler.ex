defmodule Jay.V2.Sigma.Scheduler do
  @moduledoc """
  시그마 팀 편성 스케줄러 (sigma-scheduler.ts Elixir 포트).
  어제 이벤트 기반으로 오늘 팀 편성 결정.
  """

  require Logger

  @rotation ~w(ska worker claude justin video)a
  @core_analysts ~w(pipe canvas curator)a

  @type formation :: %{
    date: String.t(),
    weekday: integer(),
    target_teams: [atom()],
    analysts: [atom()],
    formation_reason: String.t()
  }

  @doc "오늘 편성 계산 (Hub DB 이벤트 기반)"
  def build_formation(date \\ nil) do
    date = date || Date.utc_today() |> Date.to_string()
    weekday = Date.day_of_week(Date.from_iso8601!(date))

    events = collect_yesterday_events()
    target_teams = pick_target_teams(weekday, events)
    analysts = pick_analysts(events, target_teams)
    reason = build_reason(events, target_teams)

    %{
      date: date,
      weekday: weekday,
      target_teams: target_teams,
      analysts: analysts,
      formation_reason: reason
    }
  end

  # ────────────────────────────────────────────────────────────────
  # 이벤트 수집
  # ────────────────────────────────────────────────────────────────

  defp collect_yesterday_events do
    [posts, trades, low_score_rows] = [
      query_one("""
        SELECT COUNT(*)::int AS posts_published
        FROM blog.posts
        WHERE created_at >= NOW() - interval '1 day'
          AND status IN ('ready','published')
      """, "blog"),
      query_one("""
        SELECT COUNT(*)::int AS trades_executed
        FROM investment.trades
        WHERE executed_at >= NOW() - interval '1 day'
      """, "investment"),
      query_rows("""
        SELECT team, COUNT(*)::int AS low_count
        FROM agent.registry
        WHERE score < 5
        GROUP BY team
        ORDER BY low_count DESC, team ASC
      """, "agent")
    ]

    %{
      posts_published: (posts["posts_published"] || 0),
      trades_executed: (trades["trades_executed"] || 0),
      low_score_teams: Enum.map(low_score_rows, fn row ->
          team_atom = try do
            String.to_existing_atom(row["team"])
          rescue
            ArgumentError -> String.to_atom(row["team"])
          end
          {team_atom, row["low_count"]}
        end)
    }
  end

  # ────────────────────────────────────────────────────────────────
  # 편성 로직
  # ────────────────────────────────────────────────────────────────

  defp pick_target_teams(weekday, events) do
    base = rotation_teams_for_weekday(weekday)

    # 저성과 팀 추가
    low_score_teams = events[:low_score_teams]
      |> Enum.filter(fn {_, count} -> count >= 2 end)
      |> Enum.map(fn {team, _} -> team end)
      |> Enum.take(2)

    (base ++ low_score_teams) |> Enum.uniq() |> Enum.take(5)
  end

  defp rotation_teams_for_weekday(weekday) do
    idx = rem(weekday - 1, length(@rotation))
    primary = Enum.at(@rotation, idx)
    secondary_idx = rem(idx + 1, length(@rotation))
    secondary = Enum.at(@rotation, secondary_idx)
    [primary, secondary, :blog, :luna]
  end

  defp pick_analysts(events, _target_teams) do
    extra = cond do
      events[:trades_executed] == 0 -> [:hawk]           # 거래 없음 → 리스크 체크
      events[:posts_published] == 0 -> [:dove]            # 발행 없음 → 성장 점검
      length(events[:low_score_teams]) >= 3 -> [:optimizer] # 저성과 많음 → 최적화
      true -> []
    end

    (@core_analysts ++ extra) |> Enum.uniq()
  end

  defp build_reason(events, target_teams) do
    parts = ["팀: #{Enum.join(target_teams, ",")}"]
    parts = if events[:trades_executed] == 0, do: ["거래 없음" | parts], else: parts
    parts = if events[:posts_published] == 0, do: ["발행 없음" | parts], else: parts
    Enum.join(parts, " | ")
  end

  # ────────────────────────────────────────────────────────────────
  # DB 헬퍼
  # ────────────────────────────────────────────────────────────────

  defp query_one(sql, schema) do
    case Jay.Core.HubClient.pg_query(sql, schema) do
      {:ok, %{"rows" => [row | _]}} -> row
      _ -> %{}
    end
  end

  defp query_rows(sql, schema) do
    case Jay.Core.HubClient.pg_query(sql, schema) do
      {:ok, %{"rows" => rows}} -> rows
      _ -> []
    end
  end
end
