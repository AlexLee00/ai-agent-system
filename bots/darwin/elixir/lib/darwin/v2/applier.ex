defmodule Darwin.V2.Applier do
  @moduledoc """
  다윈 V2 적용자 — 검증된 연구 결과를 팀들에 배포.

  TeamJay.Darwin.Applier에서 진화:
    - Principle.Loader 체크 통과 후 적용
    - 계층별 적용 티어:
        L3/L4 + kill_switch: 마스터 승인 요청 (HubClient 알림)
        L5 + !kill_switch:   자동 적용 후 팀별 HubClient 전달
    - 팀 배포: claude(항상), luna(ML/투자), ska(효율화), jay(항상)
    - reservation.rag_research verification_status 업데이트
    - darwin.applied.{team} 이벤트 브로드캐스트
  """

  use GenServer
  require Logger

  alias Darwin.V2.{Topics, AutonomyLevel, Lead}
  alias Darwin.V2.Principle.Loader, as: PrincipleLoader
  alias Jay.Core.HubClient

  # 팀별 라우팅 규칙: {키워드 목록, 팀 아톰, 설명}
  @team_routes [
    {["investment", "trading", "financial", "portfolio", "lstm", "forecasting", "stock"],
     :luna, "투자 전략"},
    {["efficiency", "optimization", "scheduling", "reservation", "booking"],
     :ska, "예약/효율화"},
    {["blog", "content", "nlp", "text generation", "summarization", "writing"],
     :blo, "블로그 자동화"},
    {["monitoring", "system", "anomaly", "detection", "infrastructure"],
     :claude, "시스템 모니터링"}
  ]

  defstruct [applied_count: 0, last_applied_at: nil]

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "수동 적용 트리거"
  def apply_now(paper) do
    GenServer.cast(__MODULE__, {:apply_now, paper})
  end

  @impl GenServer
  def init(_opts) do
    Process.send_after(self(), :subscribe_events, 3_000)
    Logger.info("[다윈V2 적용자] 시작!")
    {:ok, %__MODULE__{}}
  end

  # ── 이벤트 처리 ──────────────────────────────────────────────────────

  @impl GenServer
  def handle_info(:subscribe_events, state) do
    Registry.register(Jay.Core.JayBus, Topics.verification_passed(), [])
    Logger.debug("[다윈V2 적용자] JayBus 구독 완료")
    {:noreply, state}
  end

  def handle_info({:jay_event, topic, payload}, state)
      when topic == "darwin.verification.passed" do
    paper = payload[:paper] || payload
    {:noreply, handle_apply(paper, payload, state)}
  end

  def handle_info({:jay_event, _topic, _payload}, state), do: {:noreply, state}
  def handle_info(_msg, state), do: {:noreply, state}

  @impl GenServer
  def handle_cast({:apply_now, paper}, state) do
    {:noreply, handle_apply(paper, %{}, state)}
  end

  # ── 내부 ─────────────────────────────────────────────────────────────

  defp handle_apply(paper, verification_payload, state) do
    level     = AutonomyLevel.level()
    kill_sw   = Application.get_env(:darwin, :kill_switch, true)
    title     = paper["title"] || paper[:title] || "unknown"

    cond do
      # L5 + kill_switch 해제: 완전 자동 (Principle 체크 통과 조건)
      level >= 5 and not kill_sw ->
        case PrincipleLoader.check("apply_research", %{paper: paper}) do
          {:approved, _} ->
            Logger.info("[다윈V2 적용자] L5 자동 적용: #{title}")
            Task.start(fn -> do_auto_apply(paper, verification_payload) end)
            %{state |
              applied_count: state.applied_count + 1,
              last_applied_at: DateTime.utc_now()
            }

          {:blocked, violations} ->
            Logger.warning("[다윈V2 적용자] 원칙 위반 — 적용 차단: #{inspect(violations)}")
            request_master_approval(paper, :principle_violation, violations)
            state
        end

      # L3/L4 또는 kill_switch 활성: 마스터 승인 요청
      true ->
        Logger.info("[다윈V2 적용자] L#{level} + kill_switch=#{kill_sw}: 마스터 승인 요청 (#{title})")
        request_master_approval(paper, :autonomy_level, [])
        state
    end
  end

  defp do_auto_apply(paper, verification_payload) do
    title         = paper["title"] || paper[:title] || "unknown"
    target_teams  = identify_target_teams(paper)
    replication   = verification_payload[:replication] || %{}
    summary       = build_application_summary(paper, replication)

    Logger.info("[다윈V2 적용자] 팀 배포: #{title} → #{inspect(target_teams)}")

    # DB 업데이트
    update_verification_status_db(paper)

    # 팀별 HubClient 전달 + applied 이벤트
    Enum.each(target_teams, fn team ->
      send_to_team(team, paper, summary)
      broadcast_applied(team, paper, summary)
    end)

    # jay 팀은 항상 상태 업데이트 수신
    unless :jay in target_teams do
      send_to_team(:jay, paper, summary)
      broadcast_applied(:jay, paper, summary)
    end

    # claude 팀도 항상 (시스템 모니터링)
    unless :claude in target_teams do
      send_to_team(:claude, paper, summary)
      broadcast_applied(:claude, paper, summary)
    end

    # AutonomyLevel 성공 기록
    AutonomyLevel.record_applied_success()
    Lead.pipeline_success()

    Task.start(fn ->
      HubClient.post_alarm(
        "다윈V2 연구 적용 완료!\n논문: #{title}\n대상 팀: #{Enum.map_join(target_teams, ", ", &to_string/1)}\n자율 레벨: L#{AutonomyLevel.level()}",
        "darwin-applier", "darwin"
      )
    end)
  end

  defp send_to_team(team, paper, summary) do
    title = paper["title"] || paper[:title] || "unknown"

    msg = case team do
      :luna ->
        "다윈팀 연구 적용 알림 (투자팀)\n논문: #{title}\n요약: #{summary}"
      :ska ->
        "다윈팀 연구 적용 알림 (SKA팀)\n논문: #{title}\n요약: #{summary}"
      :blo ->
        "다윈팀 연구 적용 알림 (블로팀)\n논문: #{title}\n요약: #{summary}"
      :claude ->
        "다윈팀 연구 적용 알림 (시스템팀)\n논문: #{title}\n요약: #{summary}"
      :jay ->
        "다윈팀 파이프라인 완료\n논문: #{title}\n적용 완료"
      _ ->
        "다윈팀 연구 적용 알림\n논문: #{title}\n요약: #{summary}"
    end

    Task.start(fn ->
      HubClient.post_alarm(msg, "darwin-applier-#{team}", to_string(team))
    end)
  end

  defp broadcast_applied(team, paper, summary) do
    topic = Topics.applied(to_string(team))
    payload = %{
      paper: paper,
      team: team,
      summary: summary,
      applied_at: DateTime.utc_now()
    }

    Registry.dispatch(Jay.Core.JayBus, topic, fn entries ->
      for {pid, _} <- entries, do: send(pid, {:jay_event, topic, payload})
    end)

    Phoenix.PubSub.broadcast(Darwin.V2.PubSub, topic, payload)
  end

  defp identify_target_teams(paper) do
    tags  = paper["tags"] || paper[:tags] || []
    title = String.downcase(paper["title"] || paper[:title] || "")
    summary = String.downcase(paper["summary"] || paper[:summary] || "")
    text = title <> " " <> summary

    matched =
      @team_routes
      |> Enum.filter(fn {keywords, _team, _desc} ->
        Enum.any?(keywords, fn kw ->
          String.contains?(text, kw) or
          Enum.any?(tags, fn tag -> String.contains?(String.downcase(to_string(tag)), kw) end)
        end)
      end)
      |> Enum.map(fn {_kw, team, _desc} -> team end)

    # 항상 기본 팀 포함
    (matched ++ [:claude, :jay]) |> Enum.uniq()
  end

  defp build_application_summary(paper, replication) do
    title = paper["title"] || paper[:title] || "unknown"
    score = paper["score"] || paper[:score] || "?"

    repro_score =
      case replication do
        %{reproduction_score: s} -> "재현점수: #{Float.round(s, 2)}"
        %{"reproduction_score" => s} -> "재현점수: #{s}"
        _ -> ""
      end

    "논문 '#{title}' (적합성 #{score}/10) #{repro_score} 구현 완료 및 검증 통과"
  end

  defp update_verification_status_db(paper) do
    paper_id = paper["id"] || paper[:id]

    if paper_id do
      sql = """
      UPDATE reservation.rag_research
      SET verification_status = 'passed'
      WHERE id = $1
      """

      case Ecto.Adapters.SQL.query(Jay.Core.Repo, sql, [paper_id]) do
        {:ok, _} -> :ok
        {:error, reason} ->
          Logger.warning("[다윈V2 적용자] DB 업데이트 실패: #{inspect(reason)}")
      end
    end
  rescue
    _ -> :ok
  end

  defp request_master_approval(paper, reason_type, violations) do
    title = paper["title"] || paper[:title] || "unknown"
    score = paper["score"] || paper[:score] || "?"

    reason_text = case reason_type do
      :principle_violation -> "원칙 위반: #{Enum.join(violations, ", ")}"
      :autonomy_level      -> "자율 레벨 부족 또는 Kill switch 활성"
      _                    -> "수동 승인 필요"
    end

    teams = identify_target_teams(paper)

    msg = """
    다윈V2 연구 적용 승인 필요!
    논문: #{title}
    적합성: #{score}/10
    대상 팀: #{Enum.map_join(teams, ", ", &to_string/1)}
    이유: #{reason_text}
    → 승인: darwin_apply_approve / 거부: darwin_apply_reject
    """

    Task.start(fn ->
      HubClient.post_alarm(msg, "darwin-apply-approval", "darwin")
    end)
  end
end
