defmodule TeamJay.Darwin.KeywordEvolver do
  @moduledoc """
  다윈팀 키워드 이볼버 — 연구 키워드 진화 오케스트레이터

  keyword-evolver.ts PortAgent의 Elixir 오케스트레이터.
  매일 00:00 실행되는 keyword-evolver.ts 결과를 처리.

  역할:
  - darwin.keyword.evolved 이벤트 수신 → 키워드 리포트 생성
  - 주간 키워드 트렌드 분석 + HubClient 알림
  - 고성과 키워드(논문 발견 기여) 보존, 저성과 키워드 제거 기록
  """

  use GenServer
  require Logger

  alias TeamJay.Darwin.Topics
  alias TeamJay.HubClient
  alias TeamJay.Repo

  @weekly_report_interval_ms 7 * 24 * 60 * 60 * 1000  # 7일

  defstruct [
    evolution_count: 0,
    last_evolved_at: nil,
    current_keywords: []
  ]

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def get_status do
    GenServer.call(__MODULE__, :get_status)
  end

  @impl true
  def init(_opts) do
    Process.send_after(self(), :subscribe_events, 3_000)
    # 7일 주기 키워드 리포트
    Process.send_after(self(), :weekly_report, @weekly_report_interval_ms)
    Logger.info("[DarwinKeywords] 키워드 이볼버 시작!")
    {:ok, %__MODULE__{}}
  end

  @impl true
  def handle_info(:subscribe_events, state) do
    Registry.register(TeamJay.JayBus, Topics.keyword_evolved(), [])
    Logger.debug("[DarwinKeywords] JayBus 구독 완료")
    {:noreply, state}
  end

  def handle_info({:jay_event, topic, payload}, state) when topic == "darwin.keyword.evolved" do
    new_state = handle_evolution(payload, state)
    {:noreply, new_state}
  end

  def handle_info(:weekly_report, state) do
    Task.start(fn -> generate_weekly_report() end)
    Process.send_after(self(), :weekly_report, @weekly_report_interval_ms)
    {:noreply, state}
  end

  def handle_info({:jay_event, _topic, _payload}, state), do: {:noreply, state}
  def handle_info(_msg, state), do: {:noreply, state}

  @impl true
  def handle_call(:get_status, _from, state) do
    {:reply, %{
      evolution_count: state.evolution_count,
      last_evolved_at: state.last_evolved_at,
      keyword_count: length(state.current_keywords)
    }, state}
  end

  # ── 내부 ───────────────────────────────────────────────────────────

  defp handle_evolution(payload, state) do
    added    = payload[:added]    || payload["added"]    || []
    removed  = payload[:removed]  || payload["removed"]  || []
    keywords = payload[:keywords] || payload["keywords"] || []

    Logger.info("[DarwinKeywords] 키워드 진화: +#{length(added)} / -#{length(removed)}")

    if added != [] or removed != [] do
      Task.start(fn ->
        HubClient.post_alarm(
          "🔑 다윈팀 키워드 진화!\n추가: #{Enum.join(added, ", ")}\n제거: #{Enum.join(removed, ", ")}",
          "darwin-keywords", "darwin"
        )
      end)
    end

    %{state |
      evolution_count: state.evolution_count + 1,
      last_evolved_at: DateTime.utc_now(),
      current_keywords: keywords
    }
  end

  defp generate_weekly_report do
    case Repo.query("""
      SELECT
        COUNT(*)::int                             AS total_papers,
        COALESCE(AVG(score), 0)::numeric(4,1)    AS avg_score,
        COUNT(*) FILTER (WHERE score >= 7)::int  AS high_score_count
      FROM rag_research
      WHERE created_at >= NOW() - INTERVAL '7 days'
    """, []) do
      {:ok, %{rows: [[total, avg, high] | _]}} ->
        Logger.info("[DarwinKeywords] 주간 리포트: 논문 #{total}건, 평균 #{avg}점, 고적합 #{high}건")
        HubClient.post_alarm(
          "📊 다윈팀 주간 리포트\n논문: #{total}건 스캔\n평균 점수: #{avg}\n고적합 (7점↑): #{high}건",
          "darwin-weekly", "darwin"
        )
      _ ->
        Logger.warning("[DarwinKeywords] 주간 리포트 조회 실패")
    end
  rescue
    e -> Logger.warning("[DarwinKeywords] 주간 리포트 에러: #{Exception.message(e)}")
  end
end
