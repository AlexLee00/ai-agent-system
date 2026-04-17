defmodule TeamJay.Darwin.TeamConnector do
  @moduledoc """
  다윈팀 팀 커넥터 — 연구 적용 결과를 대상 팀에 전달

  darwin.applied.{team} 이벤트 수신 → 각 팀 JayBus/알림 채널 포워딩

  팀별 연동:
  - :claude → claude.review.started 트리거 (코드리뷰+테스트)
  - :luna   → 투자 전략 업데이트 알림
  - :blog   → 콘텐츠 기법 업데이트 알림
  - :ska    → 파싱 기법 업데이트 알림
  - :jay    → 오케스트레이션 개선 알림
  """

  use GenServer
  require Logger

  alias TeamJay.Darwin.{Topics, TeamLead, Scanner}
  alias TeamJay.Claude.Topics, as: ClaudeTopics
  alias TeamJay.Claude.Dexter.TestRunner
  alias TeamJay.HubClient
  alias TeamJay.EventLake
  alias TeamJay.Repo

  @target_teams [:luna, :blog, :claude, :ska, :jay]

  # 팀별 관련 연구 키워드
  @team_keywords %{
    "luna"    => ["investment", "trading", "portfolio"],
    "blog"    => ["content", "nlp", "text generation"],
    "claude"  => ["code quality", "testing", "debugging"],
    "ska"     => ["web scraping", "parsing", "automation"],
    "jay"     => ["orchestration", "multi-agent", "workflow"]
  }

  defstruct [forwarded_count: 0, last_forwarded_at: nil]

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def get_status do
    GenServer.call(__MODULE__, :get_status)
  end

  @impl true
  def init(_opts) do
    Process.send_after(self(), :subscribe_events, 3_000)
    Logger.info("[DarwinConnector] 팀 커넥터 시작!")
    {:ok, %__MODULE__{}}
  end

  @doc "다윈팀 KPI 수집 (제이팀 GrowthCycle용)"
  def collect_kpi do
    GenServer.call(__MODULE__, :collect_kpi, 10_000)
  end

  @impl true
  def handle_info(:subscribe_events, state) do
    Enum.each(@target_teams, fn team ->
      Registry.register(TeamJay.JayBus, Topics.applied(to_string(team)), [])
    end)
    # 타 팀 에러 이벤트도 구독 → 관련 연구 제안
    Registry.register(TeamJay.JayBus, "system_error", [])
    Registry.register(TeamJay.JayBus, "port_agent_failed", [])
    Logger.debug("[DarwinConnector] #{length(@target_teams) + 2}개 토픽 구독 완료")
    {:noreply, state}
  end

  def handle_info({:jay_event, "darwin.applied." <> team_str, payload}, state) do
    team = String.to_existing_atom(team_str)
    paper = payload[:paper] || payload
    title = paper["title"] || paper[:title] || "unknown"
    Logger.info("[DarwinConnector] 연구 적용 전달: :#{team} ← #{title}")

    forward_to_team(team, paper)

    new_state = %{state |
      forwarded_count: state.forwarded_count + 1,
      last_forwarded_at: DateTime.utc_now()
    }
    {:noreply, new_state}
  end

  # 타 팀 에러 → 관련 논문 스캔 제안 (L4+)
  def handle_info({:jay_event, event_type, payload}, state)
      when event_type in ["system_error", "port_agent_failed"] do
    team = to_string(payload[:team] || payload["team"] || "unknown")
    if TeamLead.get_autonomy_level() >= 4 do
      Task.start(fn -> suggest_scan_for_team(team) end)
    end
    {:noreply, state}
  end

  def handle_info({:jay_event, _topic, _payload}, state), do: {:noreply, state}
  def handle_info(_msg, state), do: {:noreply, state}

  @impl true
  def handle_call(:get_status, _from, state) do
    {:reply, %{
      forwarded_count: state.forwarded_count,
      last_forwarded_at: state.last_forwarded_at,
      target_teams: @target_teams
    }, state}
  end

  def handle_call(:collect_kpi, _from, state) do
    kpi = fetch_darwin_kpi()
    {:reply, kpi, %{state | last_forwarded_at: DateTime.utc_now()}}
  end

  # ── 팀별 포워딩 ─────────────────────────────────────────────────────

  defp forward_to_team(:claude, paper) do
    # 클로드팀: SDLC 코드리뷰+테스트 트리거
    broadcast(ClaudeTopics.review_started(), %{
      source: "darwin",
      paper_title: paper["title"] || paper[:title] || "unknown",
      paper_url: paper["url"] || paper[:url],
      request_type: "research_review"
    })
    Logger.info("[DarwinConnector] 클로드팀 코드리뷰 트리거 전송")
  end

  defp forward_to_team(team, paper) do
    title = paper["title"] || paper[:title] || "unknown"
    summary = paper["summary"] || paper[:summary] || ""
    summary_short = String.slice(summary, 0, 120)

    HubClient.post_alarm(
      "🔬 다윈팀 연구 적용 → #{team_korean(team)}\n논문: #{title}\n요약: #{summary_short}",
      "darwin-connector",
      "darwin"
    )
  end

  # ── 헬퍼 ────────────────────────────────────────────────────────────

  defp extract_team(topic) do
    # "darwin.applied.luna" → :luna
    topic
    |> String.split(".")
    |> List.last()
    |> String.to_atom()
  end

  defp broadcast(topic, payload) do
    Registry.dispatch(TeamJay.JayBus, topic, fn entries ->
      for {pid, _} <- entries, do: send(pid, {:jay_event, topic, payload})
    end)
  end

  defp team_korean(:luna),  do: "루나팀 (투자 전략)"
  defp team_korean(:blog),  do: "블로팀 (콘텐츠)"
  defp team_korean(:ska),   do: "스카팀 (예약)"
  defp team_korean(:jay),   do: "제이팀 (오케스트레이션)"
  defp team_korean(other),  do: to_string(other)
end
