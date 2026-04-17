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

  alias TeamJay.Darwin.Topics
  alias TeamJay.Claude.Topics, as: ClaudeTopics
  alias TeamJay.HubClient

  @target_teams [:luna, :blog, :claude, :ska, :jay]

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

  @impl true
  def handle_info(:subscribe_events, state) do
    Enum.each(@target_teams, fn team ->
      Registry.register(TeamJay.JayBus, Topics.applied(to_string(team)), [])
    end)
    Logger.debug("[DarwinConnector] #{length(@target_teams)}개 팀 이벤트 구독 완료")
    {:noreply, state}
  end

  def handle_info({:jay_event, topic, payload}, state) do
    team = extract_team(topic)
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

  def handle_info(_msg, state), do: {:noreply, state}

  @impl true
  def handle_call(:get_status, _from, state) do
    {:reply, %{
      forwarded_count: state.forwarded_count,
      last_forwarded_at: state.last_forwarded_at,
      target_teams: @target_teams
    }, state}
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
