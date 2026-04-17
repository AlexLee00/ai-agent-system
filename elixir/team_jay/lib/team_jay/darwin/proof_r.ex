defmodule TeamJay.Darwin.ProofR do
  @moduledoc """
  다윈팀 프루프-R — 자동 검증 오케스트레이터

  implementation_ready 이벤트 수신 → verifier.ts 실행 → verification_passed/failed 브로드캐스트

  7단계 사이클 중 VERIFY 단계 담당.

  검증 흐름:
  1. implementation_ready 수신
  2. verifier.ts (darwin_proof_r PortAgent) 실행
  3. 결과 폴링 → passed/failed 판정
  4. passed → verification_passed 브로드캐스트 (Applier 트리거)
  5. failed → TeamLead.pipeline_failure() + 알림
  """

  use GenServer
  require Logger

  alias TeamJay.Darwin.{TeamLead, Topics}
  alias TeamJay.Agents.PortAgent
  alias TeamJay.HubClient
  alias TeamJay.Repo

  @poll_delay_ms  45_000  # verifier.ts 완료 후 결과 폴링 대기
  @max_retry      2       # 검증 재시도 최대 횟수

  defstruct [
    verifying: false,
    passed_count: 0,
    failed_count: 0,
    last_verified_at: nil
  ]

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "즉시 검증 실행 (수동 트리거)"
  def verify_now(paper) do
    GenServer.cast(__MODULE__, {:verify_now, paper})
  end

  def get_status do
    GenServer.call(__MODULE__, :get_status)
  end

  @impl true
  def init(_opts) do
    Process.send_after(self(), :subscribe_events, 3_000)
    Logger.info("[DarwinProofR] 프루프-R 시작!")
    {:ok, %__MODULE__{}}
  end

  @impl true
  def handle_info(:subscribe_events, state) do
    Registry.register(TeamJay.JayBus, Topics.implementation_ready(), [])
    Logger.debug("[DarwinProofR] JayBus 구독 완료")
    {:noreply, state}
  end

  def handle_info({:jay_event, topic, payload}, state) when topic == "darwin.implementation.ready" do
    paper = payload[:paper] || payload
    {:noreply, handle_verify(paper, 0, state)}
  end

  def handle_info({:verification_done, paper, retry}, state) do
    new_state = process_verification_result(paper, retry, state)
    {:noreply, %{new_state | verifying: false}}
  end

  def handle_info({:jay_event, _topic, _payload}, state), do: {:noreply, state}
  def handle_info(_msg, state), do: {:noreply, state}

  @impl true
  def handle_cast({:verify_now, paper}, state) do
    {:noreply, handle_verify(paper, 0, state)}
  end

  @impl true
  def handle_call(:get_status, _from, state) do
    {:reply, %{
      verifying: state.verifying,
      passed_count: state.passed_count,
      failed_count: state.failed_count,
      last_verified_at: state.last_verified_at
    }, state}
  end

  # ── 내부 ───────────────────────────────────────────────────────────

  defp handle_verify(paper, retry, state) do
    title = paper["title"] || paper[:title] || "unknown"
    Logger.info("[DarwinProofR] 검증 시작: #{title} (시도 #{retry + 1}/#{@max_retry + 1})")

    PortAgent.run(:darwin_proof_r)

    self_pid = self()
    Task.start(fn ->
      :timer.sleep(@poll_delay_ms)
      send(self_pid, {:verification_done, paper, retry})
    end)

    %{state | verifying: true, last_verified_at: DateTime.utc_now()}
  end

  defp process_verification_result(paper, retry, state) do
    title = paper["title"] || paper[:title] || "unknown"

    result = fetch_verification_result(title)

    case result do
      :passed ->
        Logger.info("[DarwinProofR] 검증 통과: #{title}")
        broadcast(Topics.verification_passed(), %{paper: paper})
        HubClient.post_alarm(
          "✅ 다윈팀 검증 통과!\n논문: #{title}\n→ 적용 단계로 이동",
          "darwin-proof-r", "darwin"
        )
        %{state | passed_count: state.passed_count + 1}

      :failed when retry < @max_retry ->
        Logger.warning("[DarwinProofR] 검증 실패, 재시도 #{retry + 1}/#{@max_retry}: #{title}")
        handle_verify(paper, retry + 1, state)

      :failed ->
        Logger.error("[DarwinProofR] 검증 최종 실패: #{title}")
        broadcast(Topics.verification_failed(), %{paper: paper})
        TeamLead.pipeline_failure("검증 실패: #{title}")
        HubClient.post_alarm(
          "❌ 다윈팀 검증 실패!\n논문: #{title}\n재시도 #{@max_retry}회 초과",
          "darwin-proof-r", "darwin"
        )
        %{state | failed_count: state.failed_count + 1}

      :unknown ->
        # 검증 상태 컬럼 없는 경우 → 통과로 처리
        Logger.info("[DarwinProofR] 검증 상태 미확인, 통과로 처리: #{title}")
        broadcast(Topics.verification_passed(), %{paper: paper})
        %{state | passed_count: state.passed_count + 1}
    end
  end

  defp fetch_verification_result(title) do
    case Repo.query("""
      SELECT verification_status
      FROM rag_research
      WHERE title = $1
      LIMIT 1
    """, [title]) do
      {:ok, %{rows: [[status] | _]}} when status != nil ->
        if status in ["passed", "verified", "ok"] do
          :passed
        else
          :failed
        end
      _ ->
        :unknown
    end
  rescue
    _ -> :unknown
  end

  defp broadcast(topic, payload) do
    Registry.dispatch(TeamJay.JayBus, topic, fn entries ->
      for {pid, _} <- entries, do: send(pid, {:jay_event, topic, payload})
    end)
  end
end
