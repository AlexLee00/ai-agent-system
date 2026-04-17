defmodule Sigma.V2.Commander do
  @moduledoc """
  시그마팀 Commander v2 — Jido.AI.Agent 기반 자율 판단·조율 허브.
  TS sigma-scheduler.ts + sigma-analyzer.ts 1:1 포팅.
  Phase 1: decide_formation/4 + analyze_formation/2 구현 + Shadow Mode 지원.
  Phase 2에서 AgentServer로 상시 기동 예정.
  """

  use Jido.AI.Agent,
    name: "sigma_v2_commander",
    model: :smart,
    tools: [
      Sigma.V2.Skill.DataQualityGuard,
      Sigma.V2.Skill.CausalCheck,
      Sigma.V2.Skill.ExperimentDesign,
      Sigma.V2.Skill.FeaturePlanner,
      Sigma.V2.Skill.ObservabilityPlanner
    ],
    system_prompt: """
    당신은 시그마팀 Commander v2입니다. 대도서관의 메타 오케스트레이터로,
    매일 어제 이벤트와 팀 메트릭을 바탕으로 오늘 편성을 결정합니다.

    원칙은 config/sigma_principles.yaml (P-001~031)을 따르며,
    절대 금지 사항은 Tier 3으로 강제합니다.
    Directive 실행 전 반드시 self-critique 수행.
    """

  @rotation ["ska", "worker", "claude", "justin", "video"]
  @core_analysts ["pipe", "canvas", "curator"]
  @epsilon 0.2
  @known_teams MapSet.new(["blog", "luna", "darwin", "claude", "worker", "video", "ska", "justin"])

  @type memory_snippet :: %{optional(:metadata) => map(), optional(:importance) => float()}

  @type formation :: %{
    date: String.t(),
    weekday: integer(),
    target_teams: [String.t()],
    analysts: [String.t()],
    events: map(),
    formation_reason: String.t()
  }

  # -------------------------------------------------------------------
  # Public API
  # -------------------------------------------------------------------

  @doc "오늘 편성 결정. TS decideTodayFormation() 포팅."
  @spec decide_formation(Date.t(), [memory_snippet()], [memory_snippet()], map() | nil) ::
          {:ok, formation()} | {:error, term()}
  def decide_formation(date \\ Date.utc_today(), memories \\ [], recent_semantic \\ [], yesterday_events \\ nil) do
    events = yesterday_events || collect_yesterday_events()
    memory_context = memories ++ recent_semantic

    target_teams =
      MapSet.new()
      |> add_event_teams(events)
      |> add_rotation(date)
      |> add_memory_teams(memory_context)

    memory_boost_teams = derive_memory_teams(memory_context)
    memory_perspective = derive_memory_perspective(memory_context)
    perspective = memory_perspective || select_perspective(events, date)
    task_hint = build_task_hint(perspective, memory_boost_teams)

    analysts =
      @core_analysts ++
        select_additional_analysts(events, target_teams, task_hint, @core_analysts)

    reason =
      if memory_boost_teams != [] do
        "#{perspective} / 기억 기반 보강: #{Enum.join(memory_boost_teams, ", ")}"
      else
        perspective
      end

    {:ok,
     %{
       date: Date.to_iso8601(date),
       weekday: Date.day_of_week(date),
       target_teams: MapSet.to_list(target_teams),
       analysts: Enum.uniq(analysts),
       events: events,
       formation_reason: reason
     }}
  end

  @doc "편성 분석 → 팀별 피드백 생성. TS analyzeFormation() 포팅."
  @spec analyze_formation(formation(), [memory_snippet()]) ::
          {:ok, %{report: String.t(), metrics_by_team: map(), feedbacks: [map()], insight_count: integer()}}
  def analyze_formation(formation, recent_memories \\ []) do
    target_teams = Map.get(formation, :target_teams, [])
    analysts = Map.get(formation, :analysts, [])
    primary = Enum.find(analysts, "pivot", &(&1 in ["hawk", "dove", "owl"]))
    specialists = Enum.filter(analysts, &(&1 in ["optimizer", "librarian", "forecaster"]))

    header_lines = build_report_header(formation, recent_memories)

    {body_lines, metrics_by_team, feedbacks} =
      Enum.reduce(target_teams, {["", "팀별 관찰:"], %{}, []}, fn team, {ls, metrics, fbs} ->
        metric = collect_team_metric(team)

        fb = %{
          target_team: team,
          feedback_type: infer_feedback_type(primary),
          content: build_recommendation(team, metric, primary, specialists),
          analyst_used: primary,
          before_metric: metric
        }

        {ls ++ [format_metric_line(team, metric)], Map.put(metrics, team, metric), fbs ++ [fb]}
      end)

    extra_fbs = build_specialist_feedbacks(formation, specialists, metrics_by_team)
    all_feedbacks = feedbacks ++ extra_fbs

    feedback_lines =
      ["", "제안된 피드백:"] ++
        Enum.map(all_feedbacks, fn fb ->
          "- [#{fb.target_team}] #{fb.feedback_type}: #{fb.content}"
        end)

    {:ok,
     %{
       report: Enum.join(header_lines ++ body_lines ++ feedback_lines, "\n"),
       metrics_by_team: metrics_by_team,
       feedbacks: all_feedbacks,
       insight_count: length(target_teams)
     }}
  end

  # -------------------------------------------------------------------
  # 이벤트 수집 (Shadow Mode에서 외부 호출 가능)
  # -------------------------------------------------------------------

  def collect_yesterday_events do
    blog_row = query_one("SELECT COUNT(*)::int AS posts_published FROM blog.posts WHERE created_at >= NOW() - interval '1 day' AND status IN ('ready', 'published')", [], %{posts_published: 0})
    trade_row = query_one("SELECT COUNT(*)::int AS trades_executed FROM investment.trades WHERE executed_at >= NOW() - interval '1 day'", [], %{trades_executed: 0})
    research_row = query_one("SELECT metadata FROM reservation.rag_research WHERE metadata->>'type' = 'daily_metrics' AND created_at >= NOW() - interval '2 days' ORDER BY created_at DESC LIMIT 1", [], %{metadata: %{}})
    low_rows = query_many("SELECT team, COUNT(*)::int AS low_count FROM agent.registry WHERE score < 5 GROUP BY team ORDER BY low_count DESC, team ASC", [], [])
    unhealthy = collect_launchd_unhealthy()

    low_score_teams =
      low_rows
      |> Enum.filter(&((&1[:low_count] || 0) > 0))
      |> Enum.map(&%{team: &1[:team], low_count: &1[:low_count] || 0})

    posts = blog_row[:posts_published] || 0
    trades = trade_row[:trades_executed] || 0
    metadata = research_row[:metadata] || %{}

    %{
      date: Date.to_iso8601(Date.utc_today()),
      posts_published: posts,
      trades_executed: trades,
      research_completed: (metadata[:total_collected] || 0) > 0,
      research_metrics: metadata,
      unhealthy_services: unhealthy,
      low_score_teams: low_score_teams,
      workflow_slow: (metadata[:duration_sec] || 0) > 300,
      new_experiences: metadata[:stored] || 0,
      performance_up: posts >= 2 or trades >= 2,
      error_spikes: unhealthy
    }
  end

  # -------------------------------------------------------------------
  # Private — 편성 결정 helpers
  # -------------------------------------------------------------------

  defp add_event_teams(set, events) do
    set
    |> maybe_add_team(events[:posts_published] > 0, "blog")
    |> maybe_add_team(events[:trades_executed] > 0, "luna")
    |> maybe_add_team(events[:research_completed], "darwin")
    |> add_low_score_teams(events[:low_score_teams] || [])
    |> add_unhealthy_teams(events[:unhealthy_services] || [])
  end

  defp add_rotation(set, date) do
    day_index = Date.day_of_week(date) - 1
    team = Enum.at(@rotation, rem(day_index, length(@rotation)))
    MapSet.put(set, team)
  end

  defp add_memory_teams(set, memory_context) do
    derive_memory_teams(memory_context) |> Enum.reduce(set, &MapSet.put(&2, &1))
  end

  defp maybe_add_team(set, true, team), do: MapSet.put(set, team)
  defp maybe_add_team(set, _, _team), do: set

  defp add_low_score_teams(set, teams) do
    Enum.reduce(teams, set, fn item, acc ->
      MapSet.put(acc, item[:team] || Map.get(item, :team, ""))
    end)
  end

  defp add_unhealthy_teams(set, services) do
    Enum.reduce(services, set, fn item, acc ->
      svc = item[:service] || Map.get(item, :service, "")
      acc
      |> maybe_add_team(String.contains?(svc, ".claude."), "claude")
      |> maybe_add_team(String.contains?(svc, ".worker."), "worker")
      |> maybe_add_team(String.contains?(svc, ".video"), "video")
      |> maybe_add_team(String.contains?(svc, ".ska."), "ska")
      |> maybe_add_team(String.contains?(svc, ".blog."), "blog")
    end)
  end

  defp derive_memory_teams(memories) do
    counts =
      Enum.reduce(memories, %{}, fn memory, acc ->
        metadata = memory[:metadata] || %{}
        importance = (memory[:importance] || 0) * 1.0
        weight = if importance >= 0.7, do: 2, else: 1
        teams = metadata[:targetTeams] || metadata["targetTeams"] || []

        Enum.reduce(teams, acc, fn team, inner ->
          normalized = String.downcase(to_string(team))

          if MapSet.member?(@known_teams, normalized) do
            Map.update(inner, normalized, weight, &(&1 + weight))
          else
            inner
          end
        end)
      end)

    counts
    |> Enum.filter(fn {_, score} -> score >= 2 end)
    |> Enum.sort_by(fn {team, score} -> {-score, team} end)
    |> Enum.take(2)
    |> Enum.map(fn {team, _} -> team end)
  end

  defp derive_memory_perspective(memories) do
    scores =
      Enum.reduce(memories, %{risk: 0, growth: 0, trend: 0}, fn memory, acc ->
        metadata = memory[:metadata] || %{}
        importance = (memory[:importance] || 0) * 1.0
        weight = if importance >= 0.7, do: 2, else: 1
        teams = metadata[:targetTeams] || metadata["targetTeams"] || []

        Enum.reduce(teams, acc, fn team, inner ->
          case String.downcase(to_string(team)) do
            t when t in ["claude", "worker", "ska"] -> Map.update!(inner, :risk, &(&1 + weight))
            t when t in ["blog", "luna"] -> Map.update!(inner, :growth, &(&1 + weight))
            t when t in ["darwin", "video", "justin"] -> Map.update!(inner, :trend, &(&1 + weight))
            _ -> inner
          end
        end)
      end)

    [{top_key, top_score} | _] = Enum.sort_by(scores, fn {_, v} -> -v end)
    if top_score < 2, do: nil, else: perspective_label(top_key)
  end

  defp select_perspective(events, date) do
    dow = Date.day_of_week(date)

    cond do
      (events[:error_spikes] || []) != [] -> "리스크 실패 문제 분석"
      events[:performance_up] -> "성장 성공 기회 분석"
      dow in [6, 7] -> "주간 장기 추세 분석"
      :rand.uniform() < @epsilon ->
        Enum.random(["리스크 실패 문제 분석", "성장 성공 기회 분석", "주간 장기 추세 분석"])
      true ->
        rotation = ["리스크 실패 문제 분석", "성장 성공 기회 분석", "주간 장기 추세 분석"]
        Enum.at(rotation, rem(dow - 1, length(rotation)))
    end
  end

  defp build_task_hint(perspective, []), do: perspective
  defp build_task_hint(perspective, boost), do: "#{perspective} / 최근 기억 집중팀: #{Enum.join(boost, ", ")}"

  defp perspective_label(:risk), do: "리스크 실패 문제 분석"
  defp perspective_label(:growth), do: "성장 성공 기회 분석"
  defp perspective_label(_), do: "주간 장기 추세 분석"

  defp select_additional_analysts(events, target_teams, task_hint, existing) do
    extra = [pick_agent("analyst", "sigma", task_hint, existing, "pivot")]

    extra =
      if events[:workflow_slow] or (events[:unhealthy_services] || []) != [] do
        extra ++ [pick_agent("workflow", "sigma", "워크플로우 병목 최적화", existing ++ extra, nil)]
      else
        extra
      end

    extra =
      if (events[:new_experiences] || 0) > 10 do
        extra ++ [pick_agent("rag", "sigma", "rag standing triplet 지식", existing ++ extra, nil)]
      else
        extra
      end

    extra =
      if MapSet.member?(target_teams, "luna") do
        extra ++ [pick_agent("predictor", "sigma", "성과 예측 forecast", existing ++ extra, nil)]
      else
        extra
      end

    Enum.reject(extra, &is_nil/1)
  end

  defp pick_agent(role, team, task_hint, exclude_names, fallback) do
    case Sigma.V2.AgentSelector.select_best(role, team, task_hint, exclude_names) do
      {:ok, %{name: name}} when is_binary(name) -> name
      _ -> fallback
    end
  end

  # -------------------------------------------------------------------
  # Private — 분석 helpers
  # -------------------------------------------------------------------

  defp build_report_header(formation, recent_memories) do
    target = Map.get(formation, :target_teams, []) |> Enum.join(", ")
    analysts_str = Map.get(formation, :analysts, []) |> Enum.join(", ")
    date = Map.get(formation, :date, "unknown")
    reason = Map.get(formation, :formation_reason, "일일 로테이션")

    lines = [
      "📈 시그마 일일 편성 (#{date})",
      "- 대상 팀: #{if target == "", do: "없음", else: target}",
      "- 편성: #{if analysts_str == "", do: "없음", else: analysts_str}",
      "- 기준: #{reason}"
    ]

    if recent_memories != [] do
      snippets =
        recent_memories
        |> Enum.take(3)
        |> Enum.map(&("- #{&1[:content] || ""}"))
        |> Enum.reject(&(&1 == "- "))

      if snippets != [], do: lines ++ ["", "최근 기억 참고:"] ++ snippets, else: lines
    else
      lines
    end
  end

  defp infer_feedback_type("hawk"), do: "risk_review"
  defp infer_feedback_type("dove"), do: "growth_expand"
  defp infer_feedback_type("owl"), do: "trend_watch"
  defp infer_feedback_type("optimizer"), do: "workflow_tuning"
  defp infer_feedback_type("librarian"), do: "knowledge_capture"
  defp infer_feedback_type("forecaster"), do: "forecast_adjust"
  defp infer_feedback_type(_), do: "general_review"

  defp build_recommendation(team, _m, "hawk", sp),
    do: "리스크 관점에서 #{team}의 병목/실패 패턴을 우선 점검하세요.#{specialist_suffix(sp)}"
  defp build_recommendation(team, _m, "dove", sp),
    do: "성공 패턴이 보이는 #{team}의 강점을 확대하고 재사용 가능한 운영 규칙을 추출하세요.#{specialist_suffix(sp)}"
  defp build_recommendation(team, _m, "owl", sp),
    do: "#{team}의 주간 추세를 기준으로 구조적 변화 여부를 점검하세요.#{specialist_suffix(sp)}"
  defp build_recommendation(team, _m, _, sp),
    do: "#{team}의 핵심 지표를 일일 기준으로 추적하고 다음 실행에 반영할 개선점을 정리하세요.#{specialist_suffix(sp)}"

  defp specialist_suffix([]), do: ""
  defp specialist_suffix(sp), do: " / 보조: #{Enum.join(sp, ", ")}"

  defp build_specialist_feedbacks(formation, specialists, metrics_by_team) do
    events = Map.get(formation, :events, %{})
    unhealthy = events[:unhealthy_services] || []
    new_exp = events[:new_experiences] || 0
    target_teams = Map.get(formation, :target_teams, [])

    []
    |> then(fn fbs ->
      if "optimizer" in specialists and length(unhealthy) > 0 do
        fbs ++
          [%{
            target_team: "claude",
            feedback_type: "workflow_tuning",
            content: "launchd 비정상 서비스 #{length(unhealthy)}건을 기준으로 자동 복구/재기동 정책을 점검하세요.",
            analyst_used: "optimizer",
            before_metric: %{unhealthy_services: length(unhealthy)}
          }]
      else
        fbs
      end
    end)
    |> then(fn fbs ->
      if "librarian" in specialists and new_exp > 10 do
        fbs ++
          [%{
            target_team: "darwin",
            feedback_type: "knowledge_capture",
            content: "누적 경험 #{new_exp}건을 기반으로 Standing Orders 승격 후보를 정리하세요.",
            analyst_used: "librarian",
            before_metric: %{new_experiences: new_exp}
          }]
      else
        fbs
      end
    end)
    |> then(fn fbs ->
      if "forecaster" in specialists and "luna" in target_teams do
        fbs ++
          [%{
            target_team: "luna",
            feedback_type: "forecast_adjust",
            content: "최근 거래 흐름을 기반으로 다음 24시간 변동성/포지션 리스크 예측을 추가 점검하세요.",
            analyst_used: "forecaster",
            before_metric: Map.get(metrics_by_team, "luna", %{})
          }]
      else
        fbs
      end
    end)
  end

  defp collect_team_metric("blog") do
    query_one(
      """
      SELECT 'content_ops' AS metric_type,
        COUNT(*) FILTER (WHERE created_at >= NOW() - interval '7 days' AND status = 'published')::int AS published_7d,
        COUNT(*) FILTER (WHERE status = 'ready')::int AS ready_count
      FROM blog.posts
      """,
      [],
      %{metric_type: "content_ops", published_7d: 0, ready_count: 0}
    )
  end

  defp collect_team_metric("luna") do
    query_one(
      """
      SELECT 'trading_ops' AS metric_type,
        COUNT(*) FILTER (WHERE executed_at >= NOW() - interval '7 days')::int AS trades_7d,
        COALESCE(SUM(CASE WHEN executed_at >= NOW() - interval '7 days' THEN quantity * price ELSE 0 END), 0)::float AS traded_usdt_7d,
        COUNT(*) FILTER (WHERE status = 'open')::int AS live_positions
      FROM investment.trades
      """,
      [],
      %{metric_type: "trading_ops", trades_7d: 0, traded_usdt_7d: 0.0, live_positions: 0}
    )
  end

  defp collect_team_metric("darwin") do
    query_one(
      """
      SELECT 'research_ops' AS metric_type,
        COALESCE((metadata->>'total_collected')::int, 0) AS total_collected,
        COALESCE((metadata->>'high_relevance')::int, 0) AS high_relevance,
        COALESCE((metadata->>'duration_sec')::int, 0) AS duration_sec
      FROM reservation.rag_research
      WHERE metadata->>'type' = 'daily_metrics' AND created_at >= NOW() - interval '2 days'
      ORDER BY created_at DESC LIMIT 1
      """,
      [],
      %{metric_type: "research_ops", total_collected: 0, high_relevance: 0, duration_sec: 0}
    )
  end

  defp collect_team_metric(team) do
    query_one(
      """
      SELECT 'agent_health' AS metric_type,
        COUNT(*) FILTER (WHERE status = 'active')::int AS active_agents,
        COALESCE(ROUND(AVG(score)::numeric, 2), 0)::float AS avg_score,
        COUNT(*) FILTER (WHERE score < 5)::int AS low_score_agents
      FROM agent.registry WHERE team = $1
      """,
      [team],
      %{metric_type: "agent_health", active_agents: 0, avg_score: 0.0, low_score_agents: 0}
    )
  end

  defp format_metric_line(team, metric) when is_map(metric) do
    case metric[:metric_type] || metric["metric_type"] do
      "content_ops" ->
        "- #{team}: 최근 7일 발행 #{metric[:published_7d] || 0}건, 준비 #{metric[:ready_count] || 0}건"
      "trading_ops" ->
        "- #{team}: 최근 7일 거래 #{metric[:trades_7d] || 0}건, 거래액 $#{Float.round((metric[:traded_usdt_7d] || 0.0) * 1.0, 2)}, live 포지션 #{metric[:live_positions] || 0}건"
      "research_ops" ->
        "- #{team}: 연구 수집 #{metric[:total_collected] || 0}건, 고적합 #{metric[:high_relevance] || 0}건, 소요 #{metric[:duration_sec] || 0}초"
      "agent_health" ->
        "- #{team}: 활성 에이전트 #{metric[:active_agents] || 0}명, 평균 점수 #{metric[:avg_score] || 0}, 저성과 #{metric[:low_score_agents] || 0}명"
      _ ->
        err = metric[:error] || metric["error"]
        if err, do: "- #{team}: 메트릭 수집 실패 (#{err})", else: "- #{team}: 메트릭 없음"
    end
  end

  defp format_metric_line(team, _), do: "- #{team}: 메트릭 없음"

  defp query_one(sql, params, default) do
    case TeamJay.Repo.query(sql, params) do
      {:ok, %{rows: [row | _], columns: cols}} ->
        Enum.zip(Enum.map(cols, &String.to_atom/1), row) |> Map.new()

      _ ->
        default
    end
  rescue
    _ -> default
  end

  defp query_many(sql, params, default) do
    case TeamJay.Repo.query(sql, params) do
      {:ok, %{rows: rows, columns: cols}} ->
        atom_cols = Enum.map(cols, &String.to_atom/1)
        Enum.map(rows, &(Enum.zip(atom_cols, &1) |> Map.new()))

      _ ->
        default
    end
  rescue
    _ -> default
  end

  defp collect_launchd_unhealthy do
    case System.cmd("launchctl", ["list"], stderr_to_stdout: true) do
      {output, 0} ->
        output
        |> String.split("\n")
        |> Enum.filter(&String.contains?(&1, "ai."))
        |> Enum.flat_map(fn line ->
          case String.split(line, ~r/\s+/, trim: true) do
            ["-", exit_str, service | _] ->
              case Integer.parse(exit_str) do
                {code, ""} when code != 0 -> [%{service: service, exit_code: code}]
                _ -> []
              end

            _ ->
              []
          end
        end)

      _ ->
        []
    end
  end
end
