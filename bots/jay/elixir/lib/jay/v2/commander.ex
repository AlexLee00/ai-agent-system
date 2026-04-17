defmodule Jay.V2.Commander do
  @moduledoc """
  제이팀 Commander v2 — 9팀 성장 오케스트레이터.
  Jido.AI.Agent 기반으로 매일 성장 사이클을 주도하며 9팀 전체를 조율한다.

  Phase 3: daily_growth_cycle/1 + decide_formation/1 + 6 Skills 구현.
  Phase 4에서 AgentServer로 상시 기동 예정.
  """

  use Jido.AI.Agent,
    name: "jay_v2_commander",
    model: :smart,
    tools: [
      Jay.V2.Skill.TeamHealthCheck,
      Jay.V2.Skill.FormationDecision,
      Jay.V2.Skill.CrossTeamPipeline,
      Jay.V2.Skill.AutonomyGovernor,
      Jay.V2.Skill.DailyBriefingComposer,
      Jay.V2.Skill.WeeklyReviewer
    ],
    system_prompt: """
    당신은 제이팀 Commander입니다. Team Jay 9개 팀의 최상위 오케스트레이터로,
    매일 성장 사이클(growth cycle)을 주도하며 9팀 전체의 자율 운영을 조율합니다.

    9팀 구성:
    - 시그마팀: Tier 1~3 분석가 편성 + directive 생성
    - 다윈팀: R&D 자율 (논문 발견→평가→구현→검증→적용)
    - 루나팀: 투자 분석 (크로노스 + 분석가)
    - 블로팀: 콘텐츠 자동 생산
    - 스카팀: 예약/키오스크 운영
    - 클로드팀: Claude 모니터링 + 자기 진화
    - 워커팀: 플랫폼 공통 도구
    - 에디팀: 영상 편집 자동화
    - 감정팀: 법원 SW 감정 자동화

    핵심 원칙:
    1. 팀별 자율 레벨 존중 (L3=승인요청, L4=자동프로토타입, L5=완전자동)
    2. 7개 크로스팀 파이프라인 유지 (luna→blog, darwin→all, sigma→all 등)
    3. 마스터 승인이 필요한 결정은 반드시 Telegram 알림
    4. 비용 상한 — Jay Commander 일일 $5
    5. 시그마/다윈 Shadow Mode 중단 절대 금지

    매일 06:30 KST: 9팀 상태 스캔 → 편성 결정 → 크로스팀 이벤트 발행 → 일일 브리핑.
    """

  require Logger

  @teams [:sigma, :darwin, :luna, :blog, :ska, :claude, :worker, :editor, :judgment]

  @doc "일일 성장 사이클 실행 (GrowthCycle 위임 + Commander 판단)"
  def daily_growth_cycle(opts \\ []) do
    Logger.info("[Jay.V2.Commander] 일일 성장 사이클 시작")

    with {:ok, health} <- run_team_health_check(),
         {:ok, formation} <- decide_formation(Keyword.get(opts, :date, Date.utc_today())),
         :ok <- broadcast_formation(formation) do
      {:ok, %{health: health, formation: formation}}
    end
  end

  @doc "편성 결정 (LLM 판단 — FormationDecision Skill)"
  def decide_formation(date \\ Date.utc_today()) do
    case Jay.V2.TeamConnector.collect_all() do
      team_states when is_map(team_states) ->
        params = %{
          date: Date.to_iso8601(date),
          team_states: Map.values(team_states)
        }

        Jay.V2.Skill.FormationDecision.run(params, %{})

      _ ->
        {:error, :team_states_unavailable}
    end
  end

  @doc "팀 상태 종합 분석 (TeamHealthCheck Skill)"
  def analyze_team_health(team) when team in @teams do
    Jay.V2.Skill.TeamHealthCheck.run(%{team: to_string(team)}, %{})
  end

  def analyze_team_health(_), do: {:error, :unknown_team}

  @doc "크로스팀 이벤트 발행 (CrossTeamPipeline Skill)"
  def publish_cross_team(from_team, to_team, _event_type, payload) do
    pipeline = "#{from_team}->#{to_team}"
    Jay.V2.Skill.CrossTeamPipeline.run(%{pipeline: pipeline, payload: payload}, %{})
  end

  @doc "자율 레벨 승격/강등 판정 (AutonomyGovernor Skill)"
  def review_autonomy(team) when team in @teams do
    Jay.V2.Skill.AutonomyGovernor.run(%{action: "status", team: to_string(team)}, %{})
  end

  @doc "주간 리포트 생성 (매주 월요일 — WeeklyReviewer Skill)"
  def weekly_review(week_ending \\ Date.utc_today()) do
    Jay.V2.Skill.WeeklyReviewer.run(%{week_ending: Date.to_iso8601(week_ending)}, %{})
  end

  # --- Private helpers ---

  defp run_team_health_check do
    results =
      @teams
      |> Enum.map(fn team ->
        case Jay.V2.Skill.TeamHealthCheck.run(%{team: to_string(team)}, %{}) do
          {:ok, r} -> r
          _ -> %{team: team, status: :unknown, metrics: %{}}
        end
      end)

    {:ok, results}
  end

  defp broadcast_formation(formation) do
    Jay.V2.Topics.broadcast("jay.formation.decided", formation)
    :ok
  end
end
