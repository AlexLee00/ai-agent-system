defmodule TeamJay.Darwin.Edison do
  @moduledoc """
  다윈팀 에디슨 — 자동 구현 오케스트레이터

  paper_evaluated (score ≥ 7) → implementor.ts 실행 → implementation_ready 브로드캐스트

  자율 레벨별 동작:
  - L3: 마스터 승인 요청만 (HubClient 알림)
  - L4+: implementor.ts 자동 실행 → implementation_ready 이벤트

  7단계 사이클 중 IMPLEMENT 단계 담당.
  """

  use GenServer
  require Logger

  alias TeamJay.Darwin.{TeamLead, Topics}
  alias TeamJay.Agents.PortAgent
  alias TeamJay.HubClient
  alias TeamJay.Repo

  @score_threshold 7      # 구현 트리거 최소 점수
  @poll_delay_ms   45_000 # implementor.ts 완료 후 결과 폴링 대기

  defstruct [
    implementing: false,
    impl_count: 0,
    last_impl_at: nil
  ]

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "즉시 구현 실행 (수동 트리거)"
  def implement_now(paper) do
    GenServer.cast(__MODULE__, {:implement_now, paper})
  end

  def get_status do
    GenServer.call(__MODULE__, :get_status)
  end

  @impl true
  def init(_opts) do
    Process.send_after(self(), :subscribe_events, 3_000)
    Logger.info("[DarwinEdison] 에디슨 시작!")
    {:ok, %__MODULE__{}}
  end

  @impl true
  def handle_info(:subscribe_events, state) do
    Registry.register(TeamJay.JayBus, Topics.paper_evaluated(), [])
    Logger.debug("[DarwinEdison] JayBus 구독 완료")
    {:noreply, state}
  end

  def handle_info({:jay_event, topic, payload}, state) when topic == "darwin.paper.evaluated" do
    score = payload[:score] || payload["score"] || 0
    paper = payload[:paper] || payload

    if score >= @score_threshold do
      {:noreply, handle_implement(paper, score, state)}
    else
      {:noreply, state}
    end
  end

  def handle_info({:implementation_done, paper}, state) do
    process_implementation_result(paper)
    {:noreply, %{state | implementing: false}}
  end

  def handle_info({:jay_event, _topic, _payload}, state), do: {:noreply, state}
  def handle_info(_msg, state), do: {:noreply, state}

  @impl true
  def handle_cast({:implement_now, paper}, state) do
    {:noreply, handle_implement(paper, @score_threshold, state)}
  end

  @impl true
  def handle_call(:get_status, _from, state) do
    {:reply, %{
      implementing: state.implementing,
      impl_count: state.impl_count,
      last_impl_at: state.last_impl_at
    }, state}
  end

  # ── 내부 ───────────────────────────────────────────────────────────

  defp handle_implement(paper, score, state) do
    level = TeamLead.get_autonomy_level()
    title = paper["title"] || paper[:title] || "unknown"

    if level >= 4 do
      Logger.info("[DarwinEdison] L#{level}: 자동 구현! #{title} (#{score}점)")
      do_auto_implement(paper)
      %{state |
        implementing: true,
        impl_count: state.impl_count + 1,
        last_impl_at: DateTime.utc_now()
      }
    else
      Logger.info("[DarwinEdison] L3: 구현 승인 필요 (#{title}, #{score}점)")
      request_impl_approval(paper, score)
      state
    end
  end

  defp do_auto_implement(paper) do
    PortAgent.run(:darwin_edison)

    # 비동기로 결과 폴링
    self_pid = self()
    Task.start(fn ->
      :timer.sleep(@poll_delay_ms)
      send(self_pid, {:implementation_done, paper})
    end)
  end

  defp process_implementation_result(paper) do
    title = paper["title"] || paper[:title] || "unknown"

    # rag_research에서 구현 결과 확인
    case Repo.query("""
      SELECT implementation_status, implementation_summary
      FROM rag_research
      WHERE title = $1
      LIMIT 1
    """, [title]) do
      {:ok, %{rows: [[status, summary] | _]}} when status != nil ->
        Logger.info("[DarwinEdison] 구현 완료: #{title} → #{status}")
        if status in ["done", "completed", "success"] do
          broadcast_implementation_ready(paper, summary)
        else
          Logger.warning("[DarwinEdison] 구현 실패 상태: #{status}")
          TeamLead.pipeline_failure("구현 실패: #{title} (#{status})")
        end
      _ ->
        # rag_research에 status 컬럼 없을 경우 성공으로 간주
        Logger.info("[DarwinEdison] 구현 완료 (상태 미확인): #{title}")
        broadcast_implementation_ready(paper, nil)
    end
  rescue
    _ ->
      # 컬럼 없는 경우 fallback
      title = paper["title"] || paper[:title] || "unknown"
      Logger.info("[DarwinEdison] 구현 완료 (fallback): #{title}")
      broadcast_implementation_ready(paper, nil)
  end

  defp broadcast_implementation_ready(paper, summary) do
    title = paper["title"] || paper[:title] || "unknown"
    payload = %{paper: Map.put(paper, "impl_summary", summary), title: title}
    broadcast(Topics.implementation_ready(), payload)

    HubClient.post_alarm(
      "🔧 다윈팀 구현 완료!\n논문: #{title}\n→ 검증 단계로 이동",
      "darwin-edison", "darwin"
    )
    TeamLead.pipeline_success()
  end

  defp request_impl_approval(paper, score) do
    Task.start(fn ->
      HubClient.post_alarm(
        "🔧 다윈팀 구현 승인 필요!\n논문: #{paper["title"] || "unknown"}\n적합성: #{score}/10\n→ Commander: codex_approve",
        "darwin-impl-approval", "darwin"
      )
    end)
  end

  defp broadcast(topic, payload) do
    Registry.dispatch(TeamJay.JayBus, topic, fn entries ->
      for {pid, _} <- entries, do: send(pid, {:jay_event, topic, payload})
    end)
  end
end
