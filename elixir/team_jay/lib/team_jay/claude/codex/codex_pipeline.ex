defmodule TeamJay.Claude.Codex.CodexPipeline do
  @moduledoc """
  코덱스 자동 실행 파이프라인

  Phase 1 (현재): 감지 → 마스터 텔레그램 발송 → 승인 대기 → 실행
  Phase 3 (목표): 감지 → 자동 실행 → 테스트 → 배포

  파이프라인 단계:
    ① DETECT   — CodexWatcher가 신규/수정 CODEX_*.md 감지
    ② PLAN     — dry_run으로 내용 파싱 + 텔레그램 발송
    ③ WAIT     — 마스터 승인 대기 (Phase 1)
    ④ EXECUTE  — Claude Code CLI 실행
    ⑤ TEST     — 덱스터 Layer 2 테스트
    ⑥ COMMIT   — 성공 시 커밋 + push
    ⑦ MONITOR  — DeploymentMonitor에 등록 (7일)

  승인 명령어: Claude Commander 또는 Hub API 경유
  """

  use GenServer
  require Logger

  alias TeamJay.Claude.Codex.{CodexExecutor}
  alias TeamJay.Claude.Dexter.TestRunner
  alias TeamJay.HubClient

  @project_root System.get_env("PROJECT_ROOT", "/Users/alexlee/projects/ai-agent-system")

  # 자율 실행 모드 (Phase 1: false, Phase 3: true)
  @auto_execute Application.compile_env(:team_jay, :codex_auto_execute, false)

  defstruct [
    pending: %{},     # %{codex_name => %{path, type, detected_at}}
    running: nil,     # 현재 실행 중인 codex_name
    history: [],      # 최근 10건 실행 이력
    approved: []      # 마스터 승인된 codex_name 목록
  ]

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  # ── Public API ──────────────────────────────────────────────────────

  @doc "CodexWatcher에서 호출 — 새 CODEX 감지 알림"
  def codex_detected(name, path, type) do
    GenServer.cast(__MODULE__, {:detected, name, path, type})
  end

  @doc "마스터 승인 (Commander 또는 Hub API 경유)"
  def approve(codex_name) do
    GenServer.cast(__MODULE__, {:approve, codex_name})
  end

  @doc "실행 거부"
  def reject(codex_name) do
    GenServer.cast(__MODULE__, {:reject, codex_name})
  end

  def get_status do
    GenServer.call(__MODULE__, :get_status)
  end

  def list_pending do
    GenServer.call(__MODULE__, :list_pending)
  end

  # ── GenServer ───────────────────────────────────────────────────────

  @impl true
  def init(_opts) do
    Logger.info("[CodexPipeline] 파이프라인 시작! auto_execute=#{@auto_execute}")
    {:ok, %__MODULE__{}}
  end

  @impl true
  def handle_cast({:detected, name, path, type}, state) do
    Logger.info("[CodexPipeline] ① DETECT: #{name} (#{type})")

    # dry_run으로 요약 추출
    summary = case CodexExecutor.dry_run(path) do
      {:ok, info} -> info.summary
      _ -> "요약 파싱 실패"
    end

    pending_entry = %{
      path: path,
      type: type,
      summary: summary,
      detected_at: DateTime.utc_now()
    }

    new_pending = Map.put(state.pending, name, pending_entry)
    new_state = %{state | pending: new_pending}

    # Phase 1: 텔레그램 발송 + 승인 대기
    # Phase 3: 바로 실행
    if @auto_execute do
      Logger.info("[CodexPipeline] 자동 실행 모드: #{name}")
      {:noreply, maybe_run_next(%{new_state | approved: [name | state.approved]})}
    else
      Task.start(fn -> notify_master(name, path, summary, type) end)
      {:noreply, new_state}
    end
  end

  def handle_cast({:approve, name}, state) do
    Logger.info("[CodexPipeline] ③ 마스터 승인: #{name}")
    new_approved = [name | state.approved]
    new_state = %{state | approved: new_approved}
    {:noreply, maybe_run_next(new_state)}
  end

  def handle_cast({:reject, name}, state) do
    Logger.info("[CodexPipeline] 실행 거부: #{name}")
    new_pending = Map.delete(state.pending, name)
    {:noreply, %{state | pending: new_pending}}
  end

  @impl true
  def handle_call(:get_status, _from, state) do
    {:reply, %{
      pending: map_size(state.pending),
      running: state.running,
      approved_waiting: length(state.approved),
      recent_history: Enum.take(state.history, 5)
    }, state}
  end

  def handle_call(:list_pending, _from, state) do
    pending_list = Enum.map(state.pending, fn {name, info} ->
      %{name: name, summary: info.summary, detected_at: info.detected_at,
        approved: name in state.approved}
    end)
    {:reply, pending_list, state}
  end

  @impl true
  def handle_info({:execution_done, name, result}, state) do
    Logger.info("[CodexPipeline] ④ EXECUTE 완료: #{name}")

    entry = %{name: name, result: result, completed_at: DateTime.utc_now()}
    new_history = [entry | Enum.take(state.history, 9)]
    new_pending  = Map.delete(state.pending, name)
    new_approved = List.delete(state.approved, name)
    new_state = %{state |
      running: nil,
      history: new_history,
      pending: new_pending,
      approved: new_approved
    }

    # ⑤ TEST
    Task.start(fn -> post_execution(name, result) end)

    {:noreply, maybe_run_next(new_state)}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  # ── 파이프라인 로직 ────────────────────────────────────────────────

  defp maybe_run_next(%{running: nil, approved: [next | _rest]} = state) do
    case Map.get(state.pending, next) do
      nil ->
        %{state | approved: List.delete(state.approved, next)}
      entry ->
        Logger.info("[CodexPipeline] ④ EXECUTE 시작: #{next}")
        pipeline_pid = self()
        Task.start(fn ->
          result = CodexExecutor.execute(entry.path)
          send(pipeline_pid, {:execution_done, next, result})
        end)
        %{state | running: next}
    end
  end

  defp maybe_run_next(state), do: state  # 이미 실행 중이거나 승인 없음

  defp notify_master(name, path, summary, type) do
    action = if type == :new, do: "신규", else: "수정"
    message = """
    📋 CODEX #{action} 감지!
    파일: #{name}
    요약: #{summary}
    경로: #{path}

    실행하려면: /codex approve #{name}
    거부하려면: /codex reject #{name}
    """
    HubClient.post_alarm(message, "codex-watcher", "claude")
    Logger.info("[CodexPipeline] ② PLAN: 마스터 알림 발송 완료")
  end

  defp post_execution(name, {:ok, %{exit_code: 0, output: output}}) do
    Logger.info("[CodexPipeline] ⑤ TEST 트리거: #{name}")

    # 덱스터 Layer 2 테스트 실행
    TestRunner.run_now(2)

    # ⑥ 성공 커밋
    commit_msg = "feat(codex): #{name} 자동 실행 완료"
    case System.cmd("git", ["add", "-A"], cd: @project_root) do
      {_, 0} ->
        System.cmd("git", ["commit", "-m", commit_msg], cd: @project_root)
        System.cmd("git", ["push", "origin", "main"], cd: @project_root)
        Logger.info("[CodexPipeline] ⑥ COMMIT+PUSH: #{name}")
      _ -> :skip
    end

    # ⑦ 7일 모니터링 등록
    TeamJay.Claude.Monitor.DeploymentMonitor.register(name, output)

    HubClient.post_alarm("✅ #{name} 실행 완료 → 7일 모니터링 등록", "codex-pipeline", "claude")
  end

  defp post_execution(name, {:ok, %{exit_code: code}}) do
    Logger.warning("[CodexPipeline] 실행 완료 (exit=#{code}): #{name}")
    HubClient.post_alarm("⚠️ #{name} exit=#{code} — 수동 확인 필요", "codex-pipeline", "claude")
  end

  defp post_execution(name, {:error, reason}) do
    Logger.error("[CodexPipeline] 실행 오류: #{name} — #{inspect(reason)}")
    HubClient.post_alarm("❌ #{name} 실행 오류: #{inspect(reason)}", "codex-pipeline", "claude")
  end
end
